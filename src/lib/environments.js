/**
 * Per-live-coding-language authoring help.
 *
 * Strudel is the only environment today, but Csound (WASM) and WebChucK are
 * planned siblings — so anything language-specific lives here behind a small
 * interface rather than being hard-coded into the UI:
 *
 *   id, label, docsUrl
 *   sampleToken(name)   -> how you reference a kit sample in this language
 *   hints(kit)          -> copyable teaching snippets (parameterised by the kit)
 *   makeStarter(kit)    -> one valid, playable pattern to get off the blank page
 *   makeRandom(kit)     -> a random playable pattern ("surprise me")
 *   tip                 -> the one-line orientation shown above the hints
 *   bounceUnits         -> what the Bounce dialog's range is measured in
 *   renderOffline(opts)  -> optional: non-realtime bounce to WAV bytes
 *
 * `bounceUnits` exists because the range is not universal: Strudel thinks in
 * CYCLES, Csound in SECONDS. The Bounce dialog asks the environment rather than
 * hard-coding cycles (docs/CSOUND_PLAN.md §6).
 *
 * `renderOffline` is the engine-agnostic bounce capability: given the current
 * pattern/program plus a cycle range and sample rate, render FASTER THAN REALTIME
 * and return WAV bytes. Strudel implements it with an OfflineAudioContext; Csound
 * and ChucK both have non-realtime rendering natively, so each new environment can
 * supply its own implementation and the Bounce UI keeps working unchanged. Absent
 * on an environment = no bounce offered for that language.
 *
 * Note on examples: we deliberately generate snippets from the user's own kit
 * sample names rather than copying examples from the Strudel docs — it teaches
 * the same idioms, works with the sounds actually loaded, and keeps us clear of
 * reproducing documentation. The docsUrl links out for the full language.
 *
 * GENERATED CODE CARRIES ITS OWN TEACHING. Anything we put in the editor —
 * starters, "surprise me", concept examples, and the code we ask the AI to
 * produce — should explain itself in comments: what each line does, and which
 * number to change to hear something different. The buffer is the main place
 * someone learns the language; the docs link is the fallback. Comments cost
 * nothing at runtime and are the difference between a snippet you can only run
 * and one you can read.
 */

import { renderPatternOffline } from './offlineRender.js';
import { kitFilePath } from './csoundPaths.js';

// NOTE: csoundPaths.js, not csoundEngine.js. This module is imported by App.jsx on
// every load; importing the engine would pull @csound/browser and its wasm into
// the main bundle for people who only open the Strudel tab.

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

const strudel = {
  id: 'strudel',
  label: 'Strudel',
  docsUrl: 'https://strudel.cc/workshop/getting-started/',

  tip: 'Only the last expression plays. Select part of your code to transform it, or open Concepts to browse what\u2019s possible.',

  sampleToken: (name) => `s("${name}")`,

  hints: (kit) => {
    const a = kit[0]?.name || 'sound1';
    const b = kit[1]?.name || a;
    const c = kit[2]?.name || b;
    return [
      { label: 'Repeat a sound', code: `s("${a}*4")` },
      { label: 'Sequence (one per step)', code: `s("${a} ${b} ${c}")` },
      { label: 'Layer sounds', code: `stack(\n  s("${a}*2"),\n  s("${b} ${c}")\n)` },
      { label: 'Alternate per cycle', code: `s("<${a} ${b}>")` },
      { label: 'Euclidean rhythm', code: `s("${a}(3,8)")` },
      { label: 'Pitch it', code: `note("c e g").s("${a}")` },
      { label: 'Slow it down', code: `s("${a} ${b}").slow(2)` },
    ];
  },

  makeStarter: (kit) => {
    const names = kit.map((k) => k.name);
    if (names.length === 0) return 's("sound1*4")';
    if (names.length === 1) return `s("${names[0]}*4")`;
    return `stack(\n${names.slice(0, 4).map((n) => `  s("${n}")`).join(',\n')}\n)`;
  },

  makeRandom: (kit) => {
    const names = kit.map((k) => k.name);
    if (names.length === 0) return 's("sound1*4")';

    const modify = (nm) => {
      const r = Math.random();
      if (r < 0.30) return `${nm}*${randInt(2, 4)}`;
      if (r < 0.50) return `${nm}(${randInt(2, 5)},8)`;
      if (r < 0.65 && names.length > 1) return `<${nm} ${pick(names)}>`;
      return nm;
    };
    const line = () => {
      const steps = randInt(1, 3);
      const seq = Array.from({ length: steps }, () => modify(pick(names))).join(' ');
      const tail = Math.random() < 0.35 ? `.slow(${randInt(2, 3)})`
        : (Math.random() < 0.3 ? '.rev()' : '');
      return `  s("${seq}")${tail}`;
    };
    const layers = randInt(1, Math.min(3, names.length));
    const lines = Array.from({ length: layers }, line);
    return layers === 1 ? lines[0].trim() : `stack(\n${lines.join(',\n')}\n)`;
  },

  // Non-realtime bounce (see lib/offlineRender.js).
  renderOffline: renderPatternOffline,
  bounceUnits: 'cycles',
};

// ---------------------------------------------------------------------------
// Csound (WASM) — docs/CSOUND_PLAN.md
// ---------------------------------------------------------------------------

// No `sr` line on purpose: the engine passes --sample-rate to match the browser's
// device rate, so a saved composition can't arrive detuned on a machine running at
// a different rate. ksmps 32 divides the 128-frame worklet quantum.
const CSOUND_HEADER = `ksmps = 32
nchnls = 2
0dbfs = 1`;

/**
 * A starter that LOOPS — but visibly, as a choice.
 *
 * Csound and Strudel differ here in a way worth learning rather than hiding: a
 * Strudel pattern repeats until you stop it, while a Csound score is a timeline
 * that ends. Continuity comes from an instrument that keeps scheduling — so instr
 * 99 lays out a bar and then books itself again, and the comment says that
 * deleting one line makes it play once. Both behaviours are one edit apart and
 * neither is the "normal" one.
 *
 * Built only from opcodes verified against the bundled Csound 7 beta: diskin2,
 * linen, poscil, out, schedule.
 */
function csoundStarter(kit) {
  const names = (kit || []).map((k) => k.name).filter(Boolean).slice(0, 3);
  if (!names.length) {
    return `${CSOUND_HEADER}

; ORCHESTRA — what a sound is.
instr 1
  aEnv linen 0.2, 0.02, p3, 0.5
  aSig poscil aEnv, 220
  out aSig, aSig
endin

; SCORE — when it happens: instrument 1, starting at 0 s, lasting 2 s.
<CsScore>
i 1 0 2
</CsScore>`;
  }

  const step = 0.6;
  const instrs = names.map((n, i) => `instr ${i + 1}
  ; p4 is the playback rate: 1 = as recorded, 2 = an octave up, 0.5 = an octave
  ; down. The note's length comes from p3 in the score, not from the rate.
  aSig diskin2 "${kitFilePath(n)}", p4
  aEnv linen 0.2, 0.005, p3, 0.05        ; peak level, attack, length (p3), release
  out aSig * aEnv, aSig * aEnv
endin`).join('\n\n');
  const bar = names.map((n, i) => `  schedule ${i + 1}, ${(i * step).toFixed(1)}, ${step}, 1`).join('\n');
  const barLen = (names.length * step).toFixed(1);

  return `${CSOUND_HEADER}

; ORCHESTRA — what your sounds are. One instrument each.
${instrs}

; instr 99 is the clock. Its body runs ONCE, the moment it starts — and each
; schedule books an event that many seconds FROM NOW, not from the start of the
; piece. So the last line books another copy of instr 99 one bar ahead; when that
; copy starts it books the bar again, and another copy after it. That is the loop.
; Delete that line and the bar plays once and stops.
; (The 0.1 is just how long each clock instance lives. It makes no sound.)
instr 99
${bar}
  schedule 99, ${barLen}, 0.1
endin

; SCORE — when things happen. Here it only has to start the clock.
<CsScore>
i 99 0 0.1
</CsScore>`;
}

/** "Surprise me": same shape, randomised instruments, rests, rates and envelopes. */
function csoundRandom(kit) {
  const names = (kit || []).map((k) => k.name).filter(Boolean);
  if (!names.length) return csoundStarter(kit);

  const used = names.slice(0, randInt(1, Math.min(3, names.length)));
  const step = pick([0.3, 0.4, 0.5, 0.75, 1]);

  // The comments are generated WITH the code and describe the choices actually
  // made — a surprise you can't read is just noise.
  const instrs = used.map((n, i) => {
    const amp = pick([0.15, 0.2, 0.25]);
    const atk = pick([0.002, 0.01, 0.08]);
    const rel = pick([0.03, 0.1, 0.3]);
    const atkWord = atk <= 0.005 ? 'a sharp attack' : atk >= 0.05 ? 'a soft fade-in' : 'a quick attack';
    const relWord = rel <= 0.05 ? 'cut short' : rel >= 0.3 ? 'a long tail' : 'a short tail';
    return `; Instrument ${i + 1} plays "${n}".
instr ${i + 1}
  ; p4 comes from the score: the playback rate. 2 reads through the file twice as
  ; fast (an octave up), 0.5 half as fast (an octave down). How long the note
  ; lasts is p3, not the rate.
  aSig diskin2 "${kitFilePath(n)}", p4
  ; linen: peak level, attack, total length (p3), release.
  ; This one got ${atkWord} and ${relWord}.
  aEnv linen ${amp}, ${atk}, p3, ${rel}
  out aSig * aEnv, aSig * aEnv
endin`;
  }).join('\n\n');

  const slots = randInt(3, 6);
  const lines = [];
  for (let s = 0; s < slots; s++) {
    if (Math.random() < 0.25) continue; // a rest — shows up as a gap in the starts
    const which = randInt(1, used.length);
    const rate = pick([0.5, 0.75, 1, 1, 1.25, 1.5, 2]);
    const dur = (step * pick([0.8, 1, 1.5])).toFixed(2);
    lines.push(`  schedule ${which}, ${(s * step).toFixed(2)}, ${dur}, ${rate}`);
  }
  if (!lines.length) lines.push(`  schedule 1, 0, ${step.toFixed(2)}, 1`);

  return `${CSOUND_HEADER}

; Surprise me — a random bar built from your own sounds.
; Nothing here is fixed: the numbers ARE the piece.

${instrs}

; instr 99 is the clock. Its body runs ONCE when it starts, and each schedule
; books an event that many seconds FROM NOW:
;   schedule <instrument>, <start>, <length>, <rate>
; ${slots} slots, ${step} s apart. Missing starts are rests. Change a rate to
; re-pitch that hit; change a start to move it.
instr 99
${lines.join('\n')}
  ; Books the next bar — delete this line and it plays once and stops.
  schedule 99, ${(slots * step).toFixed(2)}, 0.1
endin

; The score only has to light the fuse.
<CsScore>
i 99 0 0.1
</CsScore>`;
}

const csound = {
  id: 'csound',
  label: 'Csound',
  docsUrl: 'https://csound.com/docs/manual/',

  tip: 'Everything above <CsScore> is the orchestra \u2014 what your sounds are. Below it is the score \u2014 when they happen. A score ends; the starter keeps going because its clock instrument re-books itself.',

  // Csound reads soundfiles by FILENAME from its virtual filesystem, so the useful
  // thing to paste is the quoted path — it drops straight into diskin2.
  sampleToken: (name) => `"${kitFilePath(name)}"`,

  hints: (kit) => {
    const a = kit[0]?.name || 'sound1';
    const b = kit[1]?.name || a;
    const pa = kitFilePath(a);
    const pb = kitFilePath(b);
    return [
      { label: 'Play a kit sound', code: `aSig diskin2 "${pa}", 1` },
      { label: 'Faster / slower', code: `aSig diskin2 "${pa}", 1.5` },
      { label: 'Shape it', code: `aEnv linen 0.2, 0.01, p3, 0.1\nout aSig * aEnv, aSig * aEnv` },
      { label: 'Wrap it in an instrument', code: `instr 1\n  aSig diskin2 "${pa}", p4\n  out aSig, aSig\nendin` },
      { label: 'A note in the score', code: `i 1 0 0.6 1` },
      { label: 'Fire an event from code', code: `schedule 1, 0, 0.6, 1` },
      { label: 'Make it loop', code: `; last line of your clock instrument — it re-books itself\nschedule 99, 2.4, 0.1` },
      { label: 'Two at once (mind the headroom)', code: `aOne diskin2 "${pa}", 1\naTwo diskin2 "${pb}", 1\nout (aOne + aTwo) * 0.4, (aOne + aTwo) * 0.4` },
    ];
  },

  makeStarter: csoundStarter,
  makeRandom: csoundRandom,

  // Csound renders non-realtime natively and its range is naturally in seconds,
  // not Strudel's cycles. renderOffline lands at step 7; until then the Bounce
  // button reports that this environment can't bounce.
  bounceUnits: 'seconds',
};

const ENVIRONMENTS = { strudel, csound };

/** Tab order. */
export const ENVIRONMENT_IDS = Object.keys(ENVIRONMENTS);

export const DEFAULT_ENVIRONMENT_ID = 'strudel';

export function getEnvironment(id = DEFAULT_ENVIRONMENT_ID) {
  return ENVIRONMENTS[id] || strudel;
}
