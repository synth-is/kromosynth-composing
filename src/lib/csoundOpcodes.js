/**
 * The opcode surface of the Csound build we actually ship.
 *
 * `libcsound()` (see @csound/browser's index.d.ts) creates a lightweight wasm
 * instance with NO AudioContext and NO AudioWorklet, and its UGEN factory can list
 * every opcode the binary knows about, with input and output type strings. So this
 * is Csound describing itself — not us transcribing a manual.
 *
 * Why that matters, beyond convenience:
 *
 *  - It is automatically correct for the pinned version. docs/CSOUND_PLAN.md §4
 *    rule 2 says the reference must describe the Csound we bundle rather than the
 *    newest thing in the manual; this makes that automatic instead of a discipline
 *    someone has to remember at dependency-bump time.
 *  - It is copyright-clean. Opcode names and argument signatures are the program's
 *    own API surface, reported by the program. The manual's explanatory prose and
 *    its example .csd files are authored work and stay out of here — §4 rule 1.
 *  - It is the breadth layer for the AI. A model needs to KNOW that `partikkel`,
 *    `sndwarp` and `hilbert` exist far more than it needs their manual pages; the
 *    validate→repair loop, armed with `suggest()` below, handles the signatures.
 *
 * Cost: building the index spins up a second wasm instance. It's transient — the
 * factory and instance are destroyed as soon as the list is read, and only the
 * plain JS result is kept — and the promise is memoised, so it happens once per
 * page load at most, and only if something asks.
 *
 * NOTE: this module deliberately does NOT import csoundEngine.js. It is a separate
 * Csound instance for a separate purpose, and keeping them unaware of each other is
 * the point (see the engine's header on one-instance-one-context).
 */

import { libcsound } from '@csound/browser';
import { SURPRISE_PALETTE } from './csoundPalette.js';
import { CSOUND_REFERENCE_VERSION } from './concepts.js';

/**
 * Csound's argument-type letters. Given here so a prompt can read a signature
 * rather than just pattern-match it.
 *
 * UNVERIFIED against this build's actual output — the spike prints raw type
 * strings alongside, so any letter appearing here that the build doesn't use (or
 * vice versa) should be corrected rather than trusted.
 */
export const TYPE_LEGEND = {
  a: 'audio-rate signal',
  k: 'control-rate value',
  i: 'init-time constant',
  S: 'string',
  f: 'spectral (fsig)',
  x: 'audio- or control-rate',
  o: 'optional, defaults to 0',
  p: 'optional, defaults to 1',
  j: 'optional, defaults to -1',
  O: 'optional k-rate, defaults to 0',
  V: 'optional k-rate, defaults to 0.5',
  m: 'any number of i-rate args',
  z: 'any number of k-rate args',
  y: 'any number of a-rate args',
};

let indexPromise = null;

/**
 * A prebuilt index, if one has been generated and committed.
 *
 * Standing up `libcsound()` costs a whole second Csound wasm runtime, and doing it
 * in the live app — alongside the engine's instance, mid-performance — killed the
 * tab outright, losing the session. It also cannot tell you anything new: the
 * opcode surface of a PINNED dependency is a constant.
 *
 * So the runtime build is the fallback, not the plan. Generate the file from the
 * spike's "Export index" button and commit it over ./csoundOpcodeIndex.js;
 * regenerate when @csound/browser is bumped, alongside re-running the concept
 * harness.
 *
 * That module ships as a placeholder exporting null rather than being absent,
 * because a dynamic import of a missing file is a Vite BUILD error — `@vite-ignore`
 * doesn't help, since it only applies to non-literal specifiers.
 */
async function loadPrebuilt() {
  try {
    const { OPCODE_INDEX: data } = await import('./csoundOpcodeIndex.js');
    if (!data) return null; // placeholder — not generated yet
    if (data.version !== CSOUND_REFERENCE_VERSION) {
      console.warn(`[csoundOpcodes] prebuilt index is for ${data.version}, not `
        + `${CSOUND_REFERENCE_VERSION} — ignoring it. Regenerate from the spike.`);
      return null;
    }
    const byName = new Map();
    for (const [name, signatures] of data.entries) {
      byName.set(name, { name, signatures: signatures.map(([out, i]) => ({ out, in: i })) });
    }
    console.log(`[csoundOpcodes] prebuilt index: ${byName.size} opcodes, no wasm needed`);
    return {
      byName,
      names: [...byName.keys()].sort(),
      totalSignatures: data.entries.reduce((n, [, s]) => n + s.length, 0),
      buildMs: 0,
    };
  } catch (e) {
    console.warn('[csoundOpcodes] could not read the prebuilt index:', e?.message || e);
    return null;
  }
}

async function build() {
  const t0 = performance.now();
  // Loud on both sides, because this is the one place the app instantiates a
  // SECOND Csound wasm runtime alongside the live engine. If a tab ever dies
  // during an opcode lookup, these two lines say whether it died here.
  console.log('[csoundOpcodes] building the index (second wasm instance)…');
  const lib = await libcsound();
  if (!lib || typeof lib.csoundUgenListOpcodes !== 'function') {
    throw new Error('This @csound/browser build does not expose csoundUgenListOpcodes.');
  }

  const cs = lib.csoundCreate();
  const factory = lib.csoundUgenFactoryNew(cs);
  let raw = [];
  try {
    raw = lib.csoundUgenListOpcodes(factory) || [];
  } finally {
    // Give the wasm instance back straight away; we only keep plain JS below.
    try { lib.csoundUgenFactoryDelete(factory); } catch { /* ignore */ }
    try { lib.csoundDestroy(cs); } catch { /* ignore */ }
  }

  // Many opcodes are polymorphic — the same name appears once per type signature
  // (poscil has a-, k- and i-rate forms). Group them so a lookup answers "what
  // shapes does this take?" rather than returning an arbitrary one.
  const byName = new Map();
  for (const entry of raw) {
    const name = entry?.opname;
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, { name, signatures: [] });
    byName.get(name).signatures.push({ out: entry.outypes || '', in: entry.intypes || '' });
  }

  return {
    byName,
    names: [...byName.keys()].sort(),
    totalSignatures: raw.length,
    buildMs: Math.round(performance.now() - t0),
  };
}

/**
 * The opcode index for this build. Built once, lazily.
 *
 * NOTE the cost: `libcsound()` stands up a whole second Csound wasm runtime. The
 * factory and instance are destroyed as soon as the list is read and only plain JS
 * is kept, but the instantiation itself is the heaviest thing this module does,
 * and in the main app it happens while the live engine is already resident.
 */
export function getOpcodeIndex() {
  if (!indexPromise) {
    indexPromise = loadPrebuilt()
      .then((pre) => pre || build().then((idx) => {
        console.log(`[csoundOpcodes] index ready: ${idx.names.length} opcodes in ${idx.buildMs} ms`);
        return idx;
      }))
      .catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
}

/**
 * The text of a committable `csoundOpcodeIndex.js`. Used by the spike's export
 * button; this is the only place the runtime build is genuinely needed.
 */
export async function exportIndexModule() {
  const { byName } = await getOpcodeIndex();
  const entries = [...byName.values()]
    .map((e) => [e.name, e.signatures.map((s) => [s.out, s.in])]);
  return `/**
 * GENERATED — do not edit by hand.
 *
 * The opcode surface of @csound/browser ${CSOUND_REFERENCE_VERSION}, as reported by
 * the build itself. Regenerate with the "Export index" button in the Csound spike
 * (?csound=1) whenever the dependency is bumped, and re-run the concept harness at
 * the same time — see docs/CSOUND_PLAN.md.
 *
 * Committed so the app never has to stand up a second Csound wasm runtime just to
 * look up an opcode name.
 */
export const OPCODE_INDEX = ${JSON.stringify({ version: CSOUND_REFERENCE_VERSION, entries })};
`;
}

/** Whether `name` is a real opcode in this build. */
export async function opcodeExists(name) {
  const { byName } = await getOpcodeIndex();
  return byName.has(String(name || ''));
}

/** All signatures for one opcode, or null. */
export async function getOpcode(name) {
  const { byName } = await getOpcodeIndex();
  return byName.get(String(name || '')) || null;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[n];
}

function sharedPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Nearest real opcode names to `name` — but only ones that are PLAUSIBLY the same
 * word, misremembered.
 *
 * The threshold matters more than the ranking. Asked for the closest strings to an
 * invented name like "arpeggiate", raw edit distance happily returns
 * `create, reinit, release, prepiano…` — noise. Fed into a repair prompt that is
 * actively harmful, because the model treats a suggestion as authoritative and may
 * reach for `prepiano`. Returning NOTHING is the correct answer when the model
 * invented a concept rather than fumbling a name, and the caller can say so.
 *
 * Two cases this does catch, which are the common ones: a near-miss on a real name
 * (`moogladder2` → moogladder) and a stem (`reverb` → reverbsc, nreverb).
 */
export async function suggest(name, limit = 5, { strict = true } = {}) {
  const q = String(name || '').toLowerCase();
  if (!q) return [];
  const { names } = await getOpcodeIndex();
  const tolerance = Math.max(2, Math.floor(q.length / 4));
  const scored = [];
  for (const n of names) {
    const l = n.toLowerCase();
    const d = levenshtein(q, l);
    const stem = sharedPrefix(q, l);
    const contains = l.includes(q) || q.includes(l);
    // A three-character stem, not four. Csound's families share short prefixes —
    // pvs*, wg*, but* — and a four-character rule hid `pvsanal` from a model that
    // had invented `pvstft`, which is precisely the case this exists for. Family
    // membership is the signal; edit distance across a suffix is noise.
    if (strict && d > tolerance && stem < 3 && !contains) continue;
    // Shared prefix outranks raw distance: same family beats same length.
    scored.push({ n, score: d - stem - (contains ? 1 : 0) });
  }
  scored.sort((a, b) => a.score - b.score || a.n.length - b.n.length);
  return scored.slice(0, limit).map((s) => s.n);
}

/** One compact line per opcode, for injecting into a prompt: `moogladder: a <- akk` */
export function formatOpcode(entry) {
  if (!entry) return '';
  const sigs = entry.signatures
    .map((s) => `${s.out || '(none)'} <- ${s.in || '(none)'}`)
    .filter((s, i, all) => all.indexOf(s) === i)
    .slice(0, 4)
    .join(' | ');
  return `${entry.name}: ${sigs}`;
}

const TYPE_WORDS = {
  a: 'audio-rate signal', k: 'control-rate value', i: 'init-time constant',
  S: 'string', f: 'spectral stream', x: 'audio- or control-rate value',
  o: 'optional, defaults to 0', p: 'optional, defaults to 1',
  j: 'optional, defaults to -1', O: 'optional control-rate, defaults to 0',
  P: 'optional control-rate, defaults to 1', V: 'optional control-rate, defaults to 0.5',
  h: 'optional, defaults to 127', q: 'optional, defaults to 10',
  m: 'any number of init-time values', z: 'any number of control-rate values',
  y: 'any number of audio-rate values', W: 'any number of strings',
  M: 'any number of values', N: 'any number of values of any type',
};

/**
 * A signature spelled out one argument at a time, numbered.
 *
 * `formatOpcode`'s compact `a <- Skkkiio` is unambiguous to anyone who knows the
 * convention and actively misleading to anyone who doesn't. A model handed the
 * compact form for `diskgrain` wrote a comment reading "Grain Rate (a),
 * Modulation Rate (k), Initial Grain Size (i), Sound File Path (S)" — it treated
 * the type letters as an ordered list of ROLES and invented a meaning for each,
 * losing the actual order and putting the filename fourth when `S` comes first.
 *
 * Numbering the positions and naming each type removes the room for that.
 */
export function describeSignature(entry) {
  if (!entry) return '';
  const seen = new Set();
  const lines = [];
  for (const s of entry.signatures) {
    const key = `${s.out}|${s.in}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const outs = [...(s.out || '')].map((c) => `${c} (${TYPE_WORDS[c] || 'unknown type'})`);
    const ins = [...(s.in || '')].map((c, i) => `${i + 1}. ${c} — ${TYPE_WORDS[c] || 'unknown type'}`);
    lines.push(`${entry.name} outputs ${outs.length ? outs.join(', ') : 'nothing'}.\n`
      + `Its arguments, IN THIS ORDER, are:\n${ins.length ? ins.map((l) => `  ${l}`).join('\n') : '  (none)'}`);
    if (lines.length >= 2) break; // two forms is plenty of context
  }
  return lines.join('\n\nOr:\n');
}

// Type letters that mark an argument as optional or variadic — they don't have to
// be supplied, so they don't count toward how hard an opcode is to call.
const OPTIONAL_TYPES = new Set(['o', 'p', 'j', 'O', 'P', 'V', 'h', 'q', 'm', 'z', 'y', 'W', 'M', 'N', '*']);

/** How many arguments you must actually supply, taking the easiest overload. */
export function requiredArgCount(entry) {
  if (!entry || !entry.signatures.length) return 0;
  return Math.min(...entry.signatures.map(
    (s) => [...(s.in || '')].filter((c) => !OPTIONAL_TYPES.has(c)).length,
  ));
}

/**
 * An interesting opcode this piece isn't using yet.
 *
 * Quality-diversity pointed at the opcode space instead of the genome space: the
 * platform's own thesis is that you find good things by exploring breadth rather
 * than optimising one line, and Csound's breadth is decades deep and nearly
 * impossible to browse.
 *
 * Three filters, in order of importance:
 *  - it must EXIST in this build (the wish list in csoundPalette.js is ambitious
 *    on purpose; anything missing simply never comes up),
 *  - it must not need more than `maxArgs` required arguments. The palette runs from
 *    `mode` (three) to `partikkel` (about forty), and a small local model asked for
 *    the deep end reliably invents an argument order rather than admitting it
 *    doesn't know one. Better a technique that works than one that impresses.
 *  - it must not already be in the buffer, because the point is somewhere new,
 *  - and it must not be in `avoid`, so repeated presses keep moving.
 *
 * @returns {Promise<{name, blurb, signature}|null>} null when the palette is exhausted.
 */
export async function pickSurprise(code = '', avoid = [], { maxArgs = 8 } = {}) {
  const { byName } = await getOpcodeIndex();
  const src = String(code || '');
  const skip = new Set(avoid);
  const pool = SURPRISE_PALETTE.filter((c) => byName.has(c.name)
    && !skip.has(c.name)
    && requiredArgCount(byName.get(c.name)) <= maxArgs
    && !new RegExp(`\\b${c.name}\\b`).test(src));
  if (!pool.length) return null;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  // The signature travels with the pick. A prose blurb tells a model WHAT an
  // opcode does but not how many arguments it takes, and the interesting ones take
  // eight or ten — so a small model guesses, and guessing produces exactly the
  // "unexpected NUMBER_TOKEN" class of error. This is free: it comes from the same
  // index that chose the name. The legend rides along so the caller doesn't need
  // its own import of this module.
  return {
    ...chosen,
    signature: describeSignature(byName.get(chosen.name)),
    legend: 'Use exactly these arguments, in exactly this order.',
  };
}

/** Spelled-out signatures for one opcode, or '' — for the repair pass. */
export async function signatureOf(name) {
  const entry = await getOpcode(name);
  return entry ? describeSignature(entry) : '';
}

/** One line explaining the type letters in a signature, for prompts. */
export const SIGNATURE_LEGEND =
  'Signatures read as `outputs <- inputs`, one letter per argument in order: '
  + 'a = audio rate, k = control rate, i = set once at note start, S = string, '
  + 'x = audio or control rate, f = spectral stream. '
  + 'Later letters mark optional arguments, so supply at least the leading ones.';

/** Palette entries this build doesn't have — so the wish list can be pruned. */
export async function missingFromPalette() {
  const { byName } = await getOpcodeIndex();
  return SURPRISE_PALETTE.filter((c) => !byName.has(c.name)).map((c) => c.name);
}

/** Palette split by what this build has and what a model can realistically call. */
export async function paletteReport({ maxArgs = 8 } = {}) {
  const { byName } = await getOpcodeIndex();
  const missing = [];
  const tooDeep = [];
  const usable = [];
  for (const c of SURPRISE_PALETTE) {
    const entry = byName.get(c.name);
    if (!entry) missing.push(c.name);
    else if (requiredArgCount(entry) > maxArgs) tooDeep.push(`${c.name}(${requiredArgCount(entry)})`);
    else usable.push(c.name);
  }
  return { missing, tooDeep, usable };
}

/** Names matching a substring — the filter behind the spike's search box. */
export async function search(query, limit = 60) {
  const q = String(query || '').toLowerCase().trim();
  const { names } = await getOpcodeIndex();
  if (!q) return names.slice(0, limit);
  const starts = [];
  const contains = [];
  for (const n of names) {
    const l = n.toLowerCase();
    if (l.startsWith(q)) starts.push(n);
    else if (l.includes(q)) contains.push(n);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
