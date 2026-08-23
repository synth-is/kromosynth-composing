/**
 * Csound (WASM) engine — ONE instance, ONE AudioContext, ONE owner.
 *
 * Steps 1 & 2 of docs/CSOUND_PLAN.md: get @csound/browser running on a context we
 * own, and materialise the kit into Csound's virtual filesystem so an orchestra can
 * reference the user's own sounds by filename.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY CSOUND DOES NOT SHARE STRUDEL'S AUDIOCONTEXT
 *
 * lib/offlineRender.js documents at length how superdough's dual dist/source
 * packaging produced cross-context audio nodes and a silently half-empty bounce.
 * The trap generalises: superdough keeps the "current" AudioContext in MODULE
 * STATE, and our own bounce deliberately mutates it — `setAudioContext(offlineCtx)`
 * — for the duration of a Strudel render. Anything that resolves its context
 * lazily through `getAudioContext()` can therefore end up attaching an
 * AudioWorklet to a dead OfflineAudioContext, with no error until the audio is
 * silent.
 *
 * So Csound gets its own context, created here, never handed to superdough and
 * never read back from it. v1 rules out Strudel and Csound sounding together
 * (docs/CSOUND_PLAN.md §6), so sharing would buy nothing anyway. If we ever do
 * want one graph, that's a deliberate change here — not an accident of import
 * order.
 *
 * The same discipline applies to the Csound object itself: `initCsound()`
 * memoises its promise, so React StrictMode's dev double-mount (and any two
 * callers racing) get the same instance rather than two engines fighting over one
 * pair of speakers. Same shape as api.js's `_adoptPromise`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Lifecycle, per @csound/browser: create → setOption → compileOrc → readScore →
 * start → stop → reset → (setOption → compile → start …). Options do NOT survive
 * `reset()`, so `compileAndStart()` re-applies them every time.
 */

import { Csound } from '@csound/browser';
import { KIT_DIR, kitFilePath } from './csoundPaths.js';

// Re-exported so callers that already hold the engine don't need a second import.
export { KIT_DIR, kitFilePath };

// Bump on every edit to this file. It prints to the browser console at module
// evaluation AND into the in-app log, so "am I looking at stale code?" is a
// glance rather than a debugging session — which it cost us once already.
const ENGINE_REVISION = '2026-08-21g (raw error fallback)';
console.log('[csoundEngine] rev', ENGINE_REVISION);

const LOG_LIMIT = 500;

let ctx = null;          // our AudioContext (see header)
let csound = null;       // the single Csound instance
let initPromise = null;  // memoised — StrictMode-safe
let masterGain = null;   // Csound's node → this → destination
let audioNode = null;    // whatever @csound/browser hands us via onAudioNodeCreated
let started = false;
let kitDirChecked = false;

const logLines = [];               // { kind: 'sys'|'csound'|'error', text, t }
const listeners = new Set();       // UI subscribers
const writtenKit = new Map();      // name -> url currently materialised in the FS
const kitBytes = new Map();        // name -> { url, bytes } — survives reset()
const kitInfo = new Map();         // name -> { channels, sampleRate, frames, durationSecs }

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------
function emit() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

function say(kind, text) {
  logLines.push({ kind, text: String(text), t: Date.now() });
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  emit();
}

/** Subscribe to log/status changes. Returns an unsubscribe function. */
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getLog() { return logLines; }
export function clearLog() { logLines.length = 0; emit(); }

/** Let the WASM message callback flush before we read the log back. */
const settle = () => new Promise((r) => setTimeout(r, 40));

/**
 * Real failures logged since `fromIndex`.
 *
 * Deliberately narrow. `warning:` lines are excluded — Csound 7 warns about
 * deprecated opcodes on every good compile, and "warning: Internal error in
 * print_input_backtrace()" would otherwise read as an error. What's left is the
 * set that actually means "this will not run": score parse failures (`sread:`),
 * orchestra parse failures, and explicit `error:` lines.
 */
function collectErrors(fromIndex) {
  return logLines.slice(fromIndex)
    .map((l) => l.text.replace(/\s+/g, ' ').trim())
    .filter((t) => t && !/^warning:/i.test(t))
    .filter((t) => /^sread:/i.test(t)
      || /\bsyntax error\b/i.test(t)
      || /unable to find opcode/i.test(t)
      || /parsing failed|stopping on parser failure/i.test(t)
      // Init-pass failures. Header statements (ftgen and friends) run at start(),
      // not at compile, so these never appear until the instance is started — see
      // the note in validateOrc.
      || /^init error/i.test(t)
      || /cannot open|failed to open file|ftgen error/i.test(t)
      || /\berror:/i.test(t));
}

// Banner and bookkeeping lines Csound prints on every run. Excluded from the raw
// fallback below so it shows what went wrong rather than what always happens.
const NOISE = /^(--Csound version|\[commit|setting dummy|using libsndfile|displays suppressed|sr =|0dBFS|audio buffered|SECTION|resetting Csound|inactive allocs|overall amps|overall samples|Elapsed time|new alloc|rtevent|B\s|\d+ errors? in performance)/i;

/**
 * The last few things Csound said, whatever they were.
 *
 * `collectErrors` only recognises patterns we have met before, so a NEW kind of
 * failure produced a bare "compileOrc returned -1" with no explanation — useless to
 * the person and worse than useless in a repair prompt, which then asks a model to
 * fix an error it was never shown. When we know something failed, showing the raw
 * tail beats showing nothing.
 */
function rawSince(fromIndex, n = 4) {
  return logLines.slice(fromIndex)
    .map((l) => l.text.replace(/\s+/g, ' ').trim())
    .filter((t) => t && !NOISE.test(t))
    .slice(-n)
    .join(' | ');
}

/** Turn an init failure into something the person can act on. */
function explainInit(errs) {
  if (!errs.length) return null;
  const missing = errs.find((t) => /cannot open|failed to open file/i.test(t));
  if (missing) {
    const m = /\/kit\/([A-Za-z0-9_]+)\.wav/.exec(missing);
    if (m) {
      return `Couldn't open "${m[1]}" — there's no such sound in your kit. `
        + 'Add it from the sound browser, or use one of the names shown in the kit bar.';
    }
  }
  return errs[0];
}

export function getStatus() {
  return {
    ready: !!csound,
    started,
    contextState: ctx?.state || null,
    sampleRate: ctx?.sampleRate || null,
    nodeType: audioNode?.constructor?.name || null,
  };
}

// ---------------------------------------------------------------------------
// context + init
// ---------------------------------------------------------------------------

/** Csound's AudioContext. Ours alone — see the header. */
export function getContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}

async function _init() {
  const c = getContext();
  masterGain = c.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(c.destination);

  say('sys', `csoundEngine rev ${ENGINE_REVISION}`);
  say('sys', `AudioContext: ${c.sampleRate} Hz, state "${c.state}"`);
  // Which threading path @csound/browser can take is decided by these two. We
  // deliberately do NOT set COOP/COEP on composing.synth.is: cross-origin
  // isolation would break the CORS-open preview-WAV fetches and the spectrogram
  // images unless every upstream response also carried CORP.
  say('sys', `crossOriginIsolated: ${!!window.crossOriginIsolated} · SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined' ? 'available' : 'absent'}`);

  const cs = await Csound({ audioContext: c, autoConnect: false });
  if (!cs) throw new Error('Csound() returned nothing — check that @csound/browser loaded (see the browser console/network tab).');

  await cs.on('message', (m) => say('csound', m));
  await cs.on('onAudioNodeCreated', (node) => {
    audioNode = node;
    try {
      node.connect(masterGain);
      say('sys', `audio node: ${node.constructor?.name || 'AudioNode'} → our gain → destination`);
    } catch (e) {
      say('error', `could not connect Csound's audio node: ${e.message}`);
    }
    emit();
  });

  try { say('sys', `Csound version: ${await cs.getVersion()}`); } catch { /* optional */ }

  csound = cs;
  emit();
  return cs;
}

/** Create the engine (once). Safe to call from anywhere, any number of times. */
export function initCsound() {
  if (!initPromise) initPromise = _init().catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

// ---------------------------------------------------------------------------
// kit → Csound's virtual filesystem
// ---------------------------------------------------------------------------

/** Where a kit sound lives inside Csound's FS — see lib/csoundPaths.js. */

async function ensureKitDir(cs) {
  if (kitDirChecked) return;
  kitDirChecked = true;
  if (typeof cs.fs?.mkdir !== 'function') {
    // Not survivable by silently writing elsewhere: every generated snippet
    // hard-codes KIT_DIR, so a different path would break all of them at once.
    say('error', `fs.mkdir is unavailable in this build — cannot create ${KIT_DIR}`);
    throw new Error(`Csound's filesystem has no mkdir; cannot create ${KIT_DIR}`);
  }
  try { await cs.fs.mkdir(KIT_DIR); } catch { /* already exists — fine */ }
}

/**
 * Materialise the kit inside Csound's filesystem.
 *
 * Strudel takes sample URLs; Csound reads soundfiles by NAME from its WASM memory
 * filesystem, so every kit entry has to be fetched and written in before an
 * orchestra can touch it (docs/CSOUND_PLAN.md §3a). Both URL flavours we produce
 * are fetchable: preview WAVs are CORS-open, and renderClient's on-demand renders
 * are same-origin blob: URLs.
 *
 * Diffed against what's already written, keyed by URL — so a re-render at custom
 * settings rewrites the SAME filename and the user's code keeps working.
 *
 * @param {Object<string,string>} kitMap  { name: url } — exactly App's getKitMap()
 * @returns {Promise<Map>} name -> { channels, sampleRate, frames, durationSecs }
 */
export async function syncKit(kitMap = {}) {
  const cs = await initCsound();
  await ensureKitDir(cs);
  const names = Object.keys(kitMap).filter((n) => kitMap[n]);

  for (const name of names) {
    const url = kitMap[name];
    if (writtenKit.get(name) === url) continue;
    // Every Play resets Csound, which invalidates the FS bookkeeping — but not the
    // bytes. Cache them so a re-sync is a pure writeFile rather than a re-fetch of
    // the whole kit over the network on every recompile.
    const cached = kitBytes.get(name);
    const fromCache = !!(cached && cached.url === url);
    let bytes;
    if (fromCache) {
      bytes = cached.bytes;
    } else {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        say('error', `kit "${name}": could not fetch (${e.message})`);
        throw new Error(`Could not fetch kit sound "${name}": ${e.message}`);
      }
      kitBytes.set(name, { url, bytes });
    }
    await cs.fs.writeFile(kitFilePath(name), bytes);
    writtenKit.set(name, url);
    const info = readWavHeader(bytes);
    if (info) kitInfo.set(name, info); else kitInfo.delete(name);
    const shape = info
      ? `${info.channels === 1 ? 'mono' : `${info.channels} ch`}, ${info.sampleRate} Hz, ${info.durationSecs.toFixed(2)} s`
      : 'header not recognised';
    say('sys', `kit → ${kitFilePath(name)} (${bytes.length} bytes · ${shape}${fromCache ? ' · cached' : ''})`);
  }

  // Drop anything no longer in the kit, so stale filenames don't quietly still work.
  for (const name of [...writtenKit.keys()]) {
    if (names.includes(name)) continue;
    try { await cs.fs?.unlink?.(kitFilePath(name)); } catch { /* best effort */ }
    writtenKit.delete(name);
    kitBytes.delete(name);
    kitInfo.delete(name);
  }

  emit();
  return kitInfo;
}

/**
 * Kit bytes for `kitMap`, fetching only what isn't already cached.
 *
 * Exists so the offline bounce can write the kit into ITS OWN Csound instance
 * without re-downloading anything the live engine already holds. Returns
 * name -> Uint8Array.
 */
export async function fetchKitBytes(kitMap = {}) {
  const out = new Map();
  for (const [name, url] of Object.entries(kitMap)) {
    if (!url) continue;
    const cached = kitBytes.get(name);
    if (cached && cached.url === url) { out.set(name, cached.bytes); continue; }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch kit sound "${name}": HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    kitBytes.set(name, { url, bytes });
    out.set(name, bytes);
  }
  return out;
}

/**
 * What we know about each kit file that's in the FS.
 *
 * Worth having beyond diagnostics: renderClient produces MONO WAVs, and `diskin2`
 * needs a matching number of outputs — so the concept examples and the AI
 * reference have to say `aSig diskin2 "x.wav", 1` rather than the stereo form.
 * This is where that fact comes from instead of a guess.
 */
export function getKitInfo() { return kitInfo; }

// ---------------------------------------------------------------------------
// compile / play
// ---------------------------------------------------------------------------

/**
 * Split an editor buffer into orchestra and score.
 *
 * One buffer, not two editors. The split marker is the real `.csd` section tag
 * `<CsScore>` rather than anything we invented — so what the user learns here is
 * transferable to actual Csound files. No tag = the whole buffer is the orchestra,
 * which is the live-coding case: define instruments, fire them with `schedule`.
 *
 * The tag must be ALONE ON ITS LINE. Matching it anywhere meant the starter's own
 * explanatory comment ("Everything above <CsScore> is the ORCHESTRA") split the
 * buffer there: the orchestra collapsed to three header lines and `instr 1` …
 * `endin` went to the score parser, which read `endin` as its `e` end-statement
 * and produced silence with only `sread:` chatter to show for it.
 *
 * CSD wrappers are stripped rather than rejected, because a language model asked
 * for Csound will often emit a complete `.csd` (step 8). `<CsOptions>` is dropped
 * on purpose: the engine owns the options, and a stray `-o` there would fight the
 * realtime output.
 */
export function splitCsoundCode(code = '') {
  const src = String(code);
  const open = /^[ \t]*<CsScore>[ \t]*$/im.exec(src);
  if (!open) return { orc: stripCsdWrappers(src), sco: '' };
  const after = src.slice(open.index + open[0].length);
  const close = /^[ \t]*<\/CsScore>[ \t]*$/im.exec(after);
  return {
    orc: stripCsdWrappers(src.slice(0, open.index)),
    sco: (close ? after.slice(0, close.index) : after).trim(),
  };
}

function stripCsdWrappers(orc) {
  return String(orc)
    .replace(/<CsOptions>[\s\S]*?<\/CsOptions>/gi, '')
    .replace(/^[ \t]*<\/?(CsoundSynthesizer|CsInstruments)>[ \t]*$/gim, '')
    .trim();
}

async function applyOptions(cs, { silent = false } = {}) {
  const c = getContext();
  // `-n` runs everything EXCEPT writing audio anywhere. Validation needs the init
  // pass to happen (that is where ftgen opens soundfiles) without a blip escaping
  // to the speakers.
  await cs.setOption(silent ? '-n' : '-odac');
  await cs.setOption('-d'); // no display windows
  // Match the browser's device rate rather than letting the orchestra declare one:
  // a mismatched `sr` is a silently detuned, wrong-speed render. Starter code
  // therefore omits `sr` (docs/CSOUND_PLAN.md — spike results).
  await cs.setOption(`--sample-rate=${c.sampleRate}`);
}

/**
 * Compile an orchestra (+ optional score) and start realtime performance.
 * Resets first, so each Play is a clean slate — incremental `evalCode` live-coding
 * comes later, with the CsoundPad (step 3).
 */
export async function compileAndStart({ orc, sco = '', kitMap = null } = {}) {
  if (!orc || !orc.trim()) throw new Error('Nothing to compile.');
  const cs = await initCsound();
  const c = getContext();
  if (c.state === 'suspended') { try { await c.resume(); } catch { /* ignore */ } }

  if (started) { try { await cs.stop(); } catch { /* ignore */ } started = false; }

  await cs.reset();
  // reset() may or may not clear the in-memory FS; clearing our bookkeeping makes
  // the next syncKit rewrite everything, which is correct either way.
  writtenKit.clear();
  kitDirChecked = false;

  await applyOptions(cs);
  if (kitMap && Object.keys(kitMap).length) await syncKit(kitMap);

  const orcFrom = logLines.length;
  const status = await cs.compileOrc(orc);
  await settle();
  const orcErrs = collectErrors(orcFrom);
  if ((typeof status === 'number' && status !== 0) || orcErrs.length) {
    throw new Error(orcErrs[0] || rawSince(orcFrom) || `Orchestra did not compile (status ${status}).`);
  }

  // Csound ENDS the performance when the score runs out — the first spike run
  // closed with "end of Performance" after a 2 s note. That would kill a
  // live-coding session between edits, so a dummy f-statement far in the future
  // holds the instance up. It allocates nothing. (`f 0 z` is the idiomatic
  // "forever" form; plain seconds here so we don't lean on a magic value in a
  // beta build. 24 h is forever enough for a browser tab.)
  //
  // The score is checked too: a score Csound can't parse doesn't stop it starting,
  // it just plays NOTHING while `sread:` complaints scroll past. Silence with a
  // healthy-looking transport is the worst failure mode here, so it's an error.
  const scoFrom = logLines.length;
  await cs.readScore(`f 0 86400\n${(sco || '').trim()}`);
  await settle();
  const scoErrs = collectErrors(scoFrom);
  if (scoErrs.length) throw new Error(`Score: ${scoErrs[0]}`);

  // start() runs the INIT pass, which is where header statements like
  // `ftgen ... GEN01` actually open their files. Failures there don't throw — they
  // arrive as messages, and the raw exception when they do throw is an unreadable
  // "csound longjmp with code: 255". Either way, report what Csound said.
  const initFrom = logLines.length;
  let startThrew = null;
  try {
    await cs.start();
  } catch (e) {
    startThrew = e?.message || String(e);
  }
  await settle();
  const initErrs = collectErrors(initFrom);
  if (startThrew || initErrs.length) {
    try { await cs.stop(); } catch { /* ignore */ }
    throw new Error(explainInit(initErrs) || rawSince(initFrom) || `Csound couldn't start: ${startThrew}`);
  }
  started = true;

  // The sample-rate question the spike exists to answer: did --sample-rate win?
  try {
    const sr = Number(await cs.getSr());
    say('sys', `Csound sr = ${sr} · AudioContext = ${c.sampleRate} ${sr === c.sampleRate ? '✓ match' : '⚠ MISMATCH — pitch/speed will be wrong'}`);
  } catch { /* getSr may not exist in every build */ }

  emit();
  return true;
}

export async function stop() {
  if (!csound || !started) return;
  try { await csound.stop(); } catch (e) { say('error', `stop failed: ${e.message}`); }
  started = false;
  emit();
}

export function isStarted() { return started; }

/**
 * Compile an orchestra WITHOUT starting, and report whether it built — the
 * validate half of the AI validate→repair loop (docs/AI_EDIT_PLAN.md, and the
 * Csound plan §5).
 *
 * Two belts, because what `compileOrc` returns on a bad orchestra in this beta is
 * still unverified: we take its status AND scan the messages it emitted. Csound
 * reports compile errors through the message callback, so the text is the useful
 * half either way.
 *
 * NOTE: this resets the instance, so it STOPS playback. The caller (the AI loop)
 * plays again immediately afterwards, so that's acceptable — but don't call it
 * from anywhere that expects audio to survive.
 */
export async function validateOrc(orc, { sco = '', kitMap = null } = {}) {
  if (!orc || !orc.trim()) return { ok: false, error: 'empty orchestra' };
  const cs = await initCsound();
  if (started) { try { await cs.stop(); } catch { /* ignore */ } started = false; }

  await cs.reset();
  writtenKit.clear();
  kitDirChecked = false;
  await applyOptions(cs, { silent: true });
  // Cheap now that bytes are cached, and it keeps header-time file references
  // (ftgen/GEN01) from failing for the wrong reason.
  if (kitMap && Object.keys(kitMap).length) {
    try { await syncKit(kitMap); } catch { /* a missing sample isn't a syntax error */ }
  }

  const from = logLines.length;
  let status = null;
  let threw = null;
  try { status = await cs.compileOrc(orc); } catch (e) { threw = e?.message || String(e); }
  // The score has to be checked too. Validating the orchestra alone once passed a
  // buffer whose score was pure garbage — it "ran" and played silence.
  if (!threw && sco && sco.trim()) {
    try { await cs.readScore(`f 0 86400\n${sco.trim()}`); } catch (e) { threw = e?.message || String(e); }
  }
  // And the INIT pass, which is a third distinct place things fail. Header
  // statements — `giSnd ftgen 0, 0, 0, 1, "/kit/x.wav", 0, 0, 0` above all — do not
  // run at compile time. They run when the instance starts. Validating without
  // starting therefore gave every table-based concept a clean tick while the file
  // was never opened at all, and the failure only appeared on Play as an
  // unreadable "csound longjmp with code: 255". `-n` above keeps this silent.
  if (!threw) {
    try { await cs.start(); } catch (e) { threw = e?.message || String(e); }
    try { await cs.stop(); } catch { /* ignore */ }
  }
  await settle();
  const errs = collectErrors(from);
  const badStatus = typeof status === 'number' && status !== 0;
  const ok = !threw && !badStatus && errs.length === 0;
  emit();
  return {
    ok,
    error: ok ? null
      : (explainInit(errs) || threw || rawSince(from) || `compileOrc returned ${status}`),
  };
}

// ---------------------------------------------------------------------------
// WAV header (enough to know channels / rate / length; we already write WAVs)
// ---------------------------------------------------------------------------
function readWavHeader(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.byteLength < 44) return null;
    if (dv.getUint32(0, false) !== 0x52494646) return null;  // 'RIFF'
    if (dv.getUint32(8, false) !== 0x57415645) return null;  // 'WAVE'
    let off = 12;
    let channels = null; let sampleRate = null; let bits = null; let dataBytes = null;
    while (off + 8 <= dv.byteLength) {
      const id = dv.getUint32(off, false);
      const size = dv.getUint32(off + 4, true);
      const body = off + 8;
      if (id === 0x666d7420 && body + 16 <= dv.byteLength) {        // 'fmt '
        channels = dv.getUint16(body + 2, true);
        sampleRate = dv.getUint32(body + 4, true);
        bits = dv.getUint16(body + 14, true);
      } else if (id === 0x64617461) {                                // 'data'
        dataBytes = Math.min(size, dv.byteLength - body);
      }
      off = body + size + (size % 2);
    }
    if (!channels || !sampleRate || !bits || dataBytes == null) return null;
    const frames = Math.floor(dataBytes / (channels * (bits / 8)));
    return { channels, sampleRate, bits, frames, durationSecs: frames / sampleRate };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// This module CANNOT be hot-updated. It owns an AudioContext, an AudioWorklet and
// the one Csound instance, all in module state. A hot swap leaves the old Csound
// performing through the old node while a fresh module instance (new maps, new
// initPromise) believes it owns the world — the two-module-instances trap that
// lib/offlineRender.js documents, except here it also makes noise. Worse, it
// silently runs STALE engine code against a live editor, which is exactly how an
// already-fixed bug appeared to still be broken.
//
// So: any edit here forces a full page reload in dev.
// ---------------------------------------------------------------------------
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // Logged so that a reload originating HERE is distinguishable from one Vite
    // does for its own reasons (a re-optimised dependency, say) and from a tab the
    // browser killed. Three different causes, identical symptom.
    console.warn('[csoundEngine] hot update — forcing a full reload (see the note above)');
    window.location.reload();
  });
}
