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
 *   renderOffline(opts)  -> optional: non-realtime bounce to WAV bytes
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
 */

import { renderPatternOffline } from './offlineRender.js';

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

const strudel = {
  id: 'strudel',
  label: 'Strudel',
  docsUrl: 'https://strudel.cc/workshop/getting-started/',

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
};

const ENVIRONMENTS = { strudel };

export const DEFAULT_ENVIRONMENT_ID = 'strudel';

export function getEnvironment(id = DEFAULT_ENVIRONMENT_ID) {
  return ENVIRONMENTS[id] || strudel;
}
