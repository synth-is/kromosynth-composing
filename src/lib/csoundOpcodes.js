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

async function build() {
  const t0 = performance.now();
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

/** The opcode index for this build. Built once, lazily. */
export function getOpcodeIndex() {
  if (!indexPromise) {
    indexPromise = build().catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
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
    if (strict && d > tolerance && stem < 4 && !contains) continue;
    // A shared stem is a stronger signal than raw edit distance: someone reaching
    // for "moogladder2" wants moogladder, not a same-length unrelated name.
    let score = d;
    if (stem >= 4) score -= 3;
    else if (contains) score -= 1;
    scored.push({ n, score });
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
 *  - it must not already be in the buffer, because the point is somewhere new,
 *  - and it must not be in `avoid`, so repeated presses keep moving.
 *
 * @returns {Promise<{name, blurb}|null>} null when the palette is exhausted.
 */
export async function pickSurprise(code = '', avoid = []) {
  const { byName } = await getOpcodeIndex();
  const src = String(code || '');
  const skip = new Set(avoid);
  const pool = SURPRISE_PALETTE.filter((c) => byName.has(c.name)
    && !skip.has(c.name)
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
    signature: formatOpcode(byName.get(chosen.name)),
    legend: SIGNATURE_LEGEND,
  };
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
