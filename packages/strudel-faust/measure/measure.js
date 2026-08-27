/**
 * measure.js — the four numbers that decide the shape of the package.
 *
 * Deliberately in the spirit of the faust-elites probe page: a page that
 * answers questions, frozen or thrown away once it has. It imports the
 * package's real modules, so what it measures is what will ship.
 *
 * 1. NODE CONSTRUCTION with a warm factory.  Decides whether a per-note mono
 *    node can be the default. If it cannot, the default has to be one shared
 *    polyphonic node, which gives up superdough's per-note effects chain, which
 *    changes the whole public API.
 *
 * 2. GATE JITTER.  faustwasm moves every parameter over the MessagePort
 *    (setParamValue's AudioParam write is dead — see src/schedule.js), so a
 *    Faust note cannot be scheduled the way a BufferSource can. Three arms:
 *    `scheduled` (what the package will do), `immediate` (the raw port + render
 *    quantum floor, with no deferral) and `buffer` (an AudioBufferSourceNode
 *    started at the same target, i.e. what sample-accurate looks like on this
 *    machine). The gap between arm 1 and arm 3 is the price of Faust.
 *
 * 3. VOICE CEILING.  How many concurrent nodes before it falls over.
 *
 * 4. LIVE vs OFFLINE AGREEMENT.  The same note through the worklet and through
 *    createOfflineProcessor. The bounce path (docs/ABLETON_BRIDGE.md option B,
 *    the audio that reaches Ableton) is the offline one, so a large diff means
 *    the clip in Live is a different instrument from the one that was played.
 *    Sample-level diff stats plus a downloadable DIFF WAV, never A/B listening.
 *
 * MEASUREMENTS RUN ONE AT A TIME, and each waits for silence before arming.
 * Both rules are here because of what happened without them: several runs
 * launched together shared one tap, every arm caught the previous run's note
 * still ringing, and the reported onset error was minus the entire lead — a
 * clean, plausible-looking, entirely fictional number. The capture in
 * measurement 4 summed the overlapping voices and made the live render look 2x
 * louder than the offline one. Concurrency here does not degrade a measurement,
 * it invents one.
 */

import {
  ensureFaust, getGenerator, createFaustNode, createFaustOfflineProcessor,
  describeSource, resolveParamPath, clearFactoryCache,
} from '../src/compiler.js';
import { scheduleAtTime } from '../src/schedule.js';

// A plain voice with the three magic widget names, so the page needs no genome
// and no backend. Same shape as kromosynth/faust-genome's VOICE_PREAMBLE.
const DEFAULT_DSP = `import("stdfaust.lib");
declare options "[midi:on][nvoices:8]";
freq = hslider("freq[unit:Hz]", 440.0, 20.0, 8000.0, 0.001);
gain = hslider("gain", 0.8, 0.0, 1.0, 0.001);
gate = button("gate");
cutMul = hslider("cutMul", 6.0, 1.0, 24.0, 0.01);
q = hslider("q", 1.2, 0.5, 12.0, 0.01);
process = os.sawtooth(freq) * en.ar(0.002, 0.25, gate)
  : fi.resonlp(max(40.0, min(12000.0, freq * cutMul)), q, 1)
  : *(0.3) : *(gain);
`;

const $ = (id) => document.getElementById(id);
const src = () => $('dsp').value;
const sleep = (msec) => new Promise((r) => setTimeout(r, msec));

function log(line, kind = '') {
  const el = document.createElement('div');
  el.className = `line ${kind}`;
  el.textContent = line;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1], mean };
}

const ms = (v) => `${v.toFixed(2)} ms`;
const fmt = (st) =>
  `n=${st.n}  min ${ms(st.min)}  p50 ${ms(st.p50)}  p90 ${ms(st.p90)}  max ${ms(st.max)}`;

// ── audio setup ─────────────────────────────────────────────────────────────

let ctx = null;
let tap = null;      // the measuring worklet (also a pass-through)
let speakers = null; // gain into the destination, so it can be muted

async function ensureAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL('./tap-worklet.js', import.meta.url));
  tap = new AudioWorkletNode(ctx, 'sf-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  // Mono explicitly: everything measured here is a 1-out Faust voice, and
  // letting the graph up-mix means the recorded capture and the offline render
  // are not the same shape.
  speakers = new GainNode(ctx, { gain: $('listen').checked ? 1 : 0 });
  tap.connect(speakers).connect(ctx.destination);
  tap.port.start();
  $('listen').addEventListener('change', () => {
    speakers.gain.value = $('listen').checked ? 1 : 0;
  });
  log(`AudioContext: ${ctx.sampleRate} Hz, baseLatency ${(ctx.baseLatency ?? 0).toFixed(4)} s, outputLatency ${(ctx.outputLatency ?? 0).toFixed(4)} s`, 'ok');
  return ctx;
}

function tapOnce(request, matches) {
  return new Promise((resolve) => {
    const onMessage = (e) => {
      if (matches(e.data)) {
        tap.port.removeEventListener('message', onMessage);
        resolve(e.data);
      }
    };
    tap.port.addEventListener('message', onMessage);
    tap.port.postMessage(request);
  });
}

/** Peak seen since the last query, then reset. */
function tapPeak() {
  return tapOnce({ type: 'level' }, (d) => d?.type === 'level').then((d) => d.peak);
}

/**
 * Block until nothing is sounding. Every onset measurement depends on this:
 * an armed tap will happily report the tail of the previous note as this
 * note's attack, and the result looks entirely reasonable.
 */
async function waitForQuiet({ threshold = 0.002, timeoutMs = 3000 } = {}) {
  const t0 = performance.now();
  for (;;) {
    await sleep(25);
    const peak = await tapPeak();
    if (peak < threshold) return true;
    if (performance.now() - t0 > timeoutMs) {
      log(`still ringing (peak ${peak.toFixed(4)}) after ${timeoutMs} ms — reading may be contaminated`, 'warn');
      return false;
    }
  }
}

/** One onset report for the note we are about to trigger. */
function armOnset(id, { threshold = 0.01, notBefore = 0 } = {}) {
  return tapOnce(
    { type: 'arm', id, threshold, notBefore },
    (d) => d?.type === 'onset' && d.id === id,
  );
}

function setVoice(node, { freq = 220, gain = 0.8 } = {}) {
  const paths = node.getParams();
  const set = (name, v) => {
    const p = resolveParamPath(paths, name);
    if (p) node.setParamValue(p, v);
    return !!p;
  };
  set('freq', freq);
  set('gain', gain);
  return { set, paths };
}

function release(node) {
  try { node.disconnect(); } catch { /* already gone */ }
  try { node.destroy?.(); } catch { /* already gone */ }
}

// ── 0. introspect ───────────────────────────────────────────────────────────

async function measureIntrospect() {
  log('— introspect —');
  const t0 = performance.now();
  const info = await describeSource(src());
  log(`${(performance.now() - t0).toFixed(0)} ms  ${info.numInputs}-in / ${info.numOutputs}-out`);
  log(`voice widgets: freq=${info.voice.freq} gain=${info.voice.gain} gate=${info.voice.gate}`,
    info.voice.gate ? 'ok' : 'warn');
  if (info.numInputs !== 0) {
    log('NOT a playable voice: a 0-input generator is required, this takes audio in.', 'err');
  }
  if (!info.voice.gate) {
    log('no `gate` widget — Faust prunes widgets that reach no output, so this instrument drones.', 'warn');
  }
  const sliders = info.descriptors
    .filter((d) => !['freq', 'gain', 'gate'].includes(d.label))
    .map((d) => `${d.label} [${d.min}..${d.max}] init ${d.init}`);
  log(`patternable sliders (${sliders.length}): ${sliders.join(', ') || '(none)'}`);
}

// ── 1. compile + node construction ──────────────────────────────────────────

async function measureConstruction() {
  log('— compile + node construction —');
  await ensureAudio();
  clearFactoryCache();

  const cold = await getGenerator(src(), 1);
  log(`cold compile: ${ms(cold.compileMs)}`);
  const warm = await getGenerator(src(), 1);
  log(`cache hit: ${warm.cached ? 'yes' : 'NO — cache key mismatch'}`, warm.cached ? 'ok' : 'err');

  const n = Number($('nodes').value) || 50;
  const times = [];
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const node = await createFaustNode(ctx, src(), { polyphony: 1 });
    times.push(performance.now() - t0);
    nodes.push(node);
  }
  const st = stats(times);
  log(`createNode x${n} (warm factory): ${fmt(st)}`);
  log('(the max is the first one — it pays for audioWorklet.addModule)');
  const budget = 1000 / 8; // a sixteenth at 120 bpm
  log(st.p90 < budget
    ? `p90 is well inside a sixteenth at 120 bpm (${budget.toFixed(0)} ms) — per-note mono nodes are viable`
    : `p90 EXCEEDS a sixteenth at 120 bpm (${budget.toFixed(0)} ms) — the default may have to be a shared poly node`,
    st.p90 < budget ? 'ok' : 'warn');

  for (const node of nodes) release(node);
}

// ── 2. gate jitter ──────────────────────────────────────────────────────────

async function measureJitter(mode) {
  log(`— gate jitter (${mode}) —`);
  await ensureAudio();
  await getGenerator(src(), 1);   // warm

  const n = Number($('notes').value) || 40;
  const lead = 0.25;              // how far ahead each note is scheduled
  const noteLen = 0.15;
  const errors = [];
  let dropped = 0;
  let contaminated = 0;

  for (let i = 0; i < n; i++) {
    await waitForQuiet();

    const target = ctx.currentTime + lead;
    const id = `n${i}`;
    // `immediate` has no future target: it fires now, and the error IS the
    // latency rather than a deviation from a requested time.
    const reference = mode === 'immediate' ? ctx.currentTime : target;
    // Reject anything arriving conspicuously before the note could exist.
    const onset = armOnset(id, { notBefore: reference - 0.02 });

    let cleanup = () => {};
    if (mode === 'buffer') {
      // The floor: sample-accurate scheduling, same graph, same tap.
      const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * noteLen), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let s = 0; s < data.length; s++) {
        data[s] = 0.5 * Math.sin(2 * Math.PI * 220 * s / ctx.sampleRate);
      }
      const bs = new AudioBufferSourceNode(ctx, { buffer: buf });
      bs.connect(tap);
      bs.start(target);
      cleanup = () => { try { bs.disconnect(); } catch { /* gone */ } };
    } else {
      const node = await createFaustNode(ctx, src(), { polyphony: 1 });
      const { set } = setVoice(node, { freq: 220 });
      node.connect(tap);
      const fire = () => {
        set('gate', 1);
        scheduleAtTime(ctx, ctx.currentTime + noteLen, () => set('gate', 0));
      };
      if (mode === 'scheduled') scheduleAtTime(ctx, target, fire);
      else fire();   // `immediate`: no deferral at all
      cleanup = () => release(node);
    }

    const got = await Promise.race([onset, sleep(2000).then(() => null)]);
    if (!got) {
      dropped++;
      log(`note ${i}: no onset within 2 s`, 'warn');
    } else {
      const err = (got.time - reference) * 1000;
      // A negative error beyond the tap's own tolerance means we timed
      // something that was not this note.
      if (err < -20) contaminated++;
      else errors.push(err);
    }
    // Let the note finish before disconnecting, or the tail is a click.
    await sleep((noteLen + 0.15) * 1000);
    cleanup();
  }

  if (dropped) log(`${dropped} note(s) produced no onset`, 'warn');
  if (contaminated) log(`${contaminated} reading(s) discarded as contaminated`, 'warn');
  if (!errors.length) { log('no usable readings', 'err'); return; }

  const st = stats(errors);
  const spread = st.max - st.min;
  log(`onset error vs target: ${fmt(st)}`);
  log(`mean ${st.mean.toFixed(2)} ms, spread ${spread.toFixed(2)} ms`, spread < 10 ? 'ok' : 'warn');
  log('(a constant offset is correctable by a lead; SPREAD is what cannot be corrected)');
}

// ── 3. voice ceiling ────────────────────────────────────────────────────────

async function measureCeiling() {
  log('— voice ceiling —');
  await ensureAudio();
  await getGenerator(src(), 1);
  const n = Number($('voices').value) || 32;

  const nodes = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const node = await createFaustNode(ctx, src(), { polyphony: 1 });
    const { set } = setVoice(node, { freq: 110 * Math.pow(2, (i % 12) / 12), gain: 0.3 / Math.sqrt(n) });
    node.connect(tap);
    set('gate', 1);
    nodes.push({ node, set });
  }
  log(`${n} voices created + gated in ${ms(performance.now() - t0)}`);
  log('listen for dropouts; check the console for AudioWorklet underrun warnings');
  await sleep(3000);
  for (const { set } of nodes) {
    try { set('gate', 0); } catch { /* gone */ }
  }
  await sleep(800);
  for (const { node } of nodes) release(node);
  log(`${n} voices released`);
}

// ── 4. live vs offline ──────────────────────────────────────────────────────

function recordFor(seconds) {
  const done = tapOnce({ type: 'record', maxSeconds: seconds + 0.5 }, (d) => d?.type === 'recording');
  setTimeout(() => tap.port.postMessage({ type: 'stop' }), seconds * 1000);
  return done;
}

async function renderOffline({ seconds, gateOff, freq, sampleRate }) {
  const blockSize = 128;
  const proc = await createFaustOfflineProcessor(src(), { sampleRate, blockSize });
  // MANDATORY: FaustWebAudioDsp.compute() is a no-op until start() has run, and
  // it fails silently — you get a buffer of zeros, not an error.
  proc.start();
  const paths = proc.getParams();
  const set = (name, v) => {
    const p = resolveParamPath(paths, name);
    if (p) proc.setParamValue(p, v);
    return !!p;
  };
  set('freq', freq);
  set('gain', 0.8);
  const hasGate = set('gate', 1);

  const total = Math.round(seconds * sampleRate);
  const gateOffSample = Math.round(gateOff * sampleRate);
  const out = new Float32Array(total);
  // compute() writes into buffers of exactly bufferSize; slice on the way out.
  const outBlock = [new Float32Array(blockSize)];
  let written = 0;
  let released = false;
  while (written < total) {
    if (hasGate && !released && written >= gateOffSample) { set('gate', 0); released = true; }
    proc.compute([], outBlock);
    const n = Math.min(blockSize, total - written);
    out.set(outBlock[0].subarray(0, n), written);
    written += n;
  }
  proc.stop();
  return out;
}

async function measureAgreement() {
  log('— live vs offline —');
  await ensureAudio();
  await waitForQuiet();
  const seconds = 1.5;
  const gateOff = 0.4;
  const freq = 220;

  const node = await createFaustNode(ctx, src(), { polyphony: 1 });
  const { set } = setVoice(node, { freq });
  node.connect(tap);

  const recording = recordFor(seconds);
  set('gate', 1);
  scheduleAtTime(ctx, ctx.currentTime + gateOff, () => set('gate', 0));
  const rec = await recording;
  release(node);

  const offline = await renderOffline({ seconds, gateOff, freq, sampleRate: ctx.sampleRate });
  const live = rec.samples;

  // Align on first onset: the live capture starts whenever the recorder did,
  // the offline render starts at the gate. Comparing unaligned buffers would
  // report a difference that is entirely start offset.
  const firstOnset = (xs, thr = 0.005) => {
    for (let i = 0; i < xs.length; i++) if (Math.abs(xs[i]) > thr) return i;
    return -1;
  };
  const lo = firstOnset(live);
  const oo = firstOnset(offline);
  if (lo < 0 || oo < 0) {
    log(`no onset found (live ${lo}, offline ${oo}) — nothing to compare`, 'err');
    return;
  }
  const n = Math.min(live.length - lo, offline.length - oo);
  const diff = new Float32Array(n);
  let sum = 0, peak = 0, lPeak = 0, oPeak = 0;
  for (let i = 0; i < n; i++) {
    const d = live[lo + i] - offline[oo + i];
    diff[i] = d;
    sum += d * d;
    const a = Math.abs(d); if (a > peak) peak = a;
    const la = Math.abs(live[lo + i]); if (la > lPeak) lPeak = la;
    const oa = Math.abs(offline[oo + i]); if (oa > oPeak) oPeak = oa;
  }
  const rms = Math.sqrt(sum / n);
  const ratio = lPeak / (oPeak || 1e-9);
  log(`aligned ${n} samples (live +${lo}, offline +${oo})`);
  log(`peak: live ${lPeak.toFixed(4)}  offline ${oPeak.toFixed(4)}  ratio ${ratio.toFixed(3)}`);
  log(`diff: peak ${peak.toFixed(5)}  rms ${rms.toFixed(6)}  (${(20 * Math.log10(rms + 1e-12)).toFixed(1)} dBFS)`);
  if (ratio > 1.5 || ratio < 0.67) {
    log('a peak ratio near a whole number usually means summed voices rather than a renderer difference — check nothing else was still connected.', 'warn');
  }
  log('not expected to be bit-identical: different block boundaries, and the live gate lands on a quantum edge. The ENVELOPE should match.');
  window.__sf = { live, offline, diff, sampleRate: ctx.sampleRate };
  log('buffers on window.__sf — use the download button for the DIFF WAV');
  $('dl').disabled = false;
}

// Minimal 16-bit mono WAV, so a diff can be opened in an editor.
function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function downloadDiff() {
  const d = window.__sf;
  if (!d) return;
  // NOT peak-normalised, on purpose: the absolute level of the difference is
  // the finding. Normalising it would make a negligible diff look alarming.
  const url = URL.createObjectURL(encodeWav(d.diff, d.sampleRate));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'live-minus-offline.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── wiring ──────────────────────────────────────────────────────────────────

$('dsp').value = DEFAULT_DSP;

const BUTTONS = ['introspect', 'construction', 'jitter-scheduled', 'jitter-immediate',
  'jitter-buffer', 'ceiling', 'agreement'];
let busy = false;

/**
 * One measurement at a time. Not politeness — concurrent runs share the tap and
 * produce confident, wrong numbers rather than obviously broken ones.
 */
const run = (fn) => async () => {
  if (busy) return;
  busy = true;
  for (const id of BUTTONS) $(id).disabled = true;
  document.body.style.cursor = 'progress';
  try { await fn(); }
  catch (err) { log(String(err?.message || err), 'err'); console.error(err); }
  finally {
    busy = false;
    for (const id of BUTTONS) $(id).disabled = false;
    document.body.style.cursor = '';
    log('');
  }
};

$('introspect').addEventListener('click', run(measureIntrospect));
$('construction').addEventListener('click', run(measureConstruction));
$('jitter-scheduled').addEventListener('click', run(() => measureJitter('scheduled')));
$('jitter-immediate').addEventListener('click', run(() => measureJitter('immediate')));
$('jitter-buffer').addEventListener('click', run(() => measureJitter('buffer')));
$('ceiling').addEventListener('click', run(measureCeiling));
$('agreement').addEventListener('click', run(measureAgreement));
$('dl').addEventListener('click', downloadDiff);
$('clear').addEventListener('click', () => { $('log').innerHTML = ''; });

log('ready — click Introspect first (it loads libfaust, ~7.6 MB)');
log('one measurement at a time: the buttons disable while one is running');
ensureFaust().then(() => log('libfaust loaded', 'ok')).catch((e) => log(String(e.message), 'err'));
