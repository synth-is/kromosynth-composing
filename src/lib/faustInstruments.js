/**
 * Faust instruments for the Strudel pad.
 *
 * The bridge between "a thing the user picked" and "a name you can play":
 * packages/strudel-faust consumes ONLY a self-contained `.dsp` string, so
 * everything that knows about genomes, URLs and Synth.is sound entries lives
 * here rather than in the package.
 *
 * Three sources, one destination:
 *
 *   URL     — any `.dsp` on the web, or one of ours at /faust-templates/. This
 *             is the "play someone else's Faust instrument" path, and it works
 *             with files that have nothing to do with kromosynth.
 *   TEXT    — pasted source, e.g. from the desktop app's Template Workshop.
 *   GENOME  — a Faust-substrate genome from a QD run: deserialise, then
 *             faustGenomeToDSP(). This is the "play our discoveries" path.
 *
 * NOT EVERY SYNTH.IS SOUND IS A FAUST GENOME. The corpus is overwhelmingly
 * CPPN+DSP (substrate #1), which is not a Faust voice and cannot be played this
 * way — those keep going through the existing kit/sample route. isFaustGenome()
 * is the discriminator, and anything else is reported rather than coerced.
 */

import {
  faustSounds, faustSliders, describeSource, silenceFaustNodeLogs, faustParamMethod, setFaustDebug,
  whenStrudelScopeReady,
} from '@kromosynth/strudel-faust';
import { fetchGenome } from './renderClient.js';
import { getEvoRunId } from './render.js';

// faustwasm logs `sampleSize: N bufferSize: N` on every node construction, and
// here a node is a note. Filtered at import time so the console stays readable
// during a pattern; silenceFaustNodeLogs() returns an uninstall function if that
// line is ever wanted back.
silenceFaustNodeLogs();

// kromosynth's Faust genome module pulls in neatjs/cppnjs for the wavetable
// networks. Dynamically imported so a session that never touches a Faust
// genome never loads it — the same reasoning as browserRender.js.
let _genomeModule = null;
function getGenomeModule() {
  if (!_genomeModule) _genomeModule = import('kromosynth/faust-genome/genome.js');
  return _genomeModule;
}

let _substrateReady = false;

/**
 * Initialise the Faust substrate. NOT NEEDED FOR PLAYBACK, and it throws here.
 *
 * `initFaustSubstrate` builds the seed table, which allocates NeatGenome
 * innovation IDs, which calls cuid, which reads `process.pid` — a Node-only
 * path. In the browser that dies with "Cannot read properties of undefined
 * (reading 'toString')" inside neatjs. browserRender.js never hit it because
 * DESERIALISING a genome allocates no innovation IDs; only creating one does.
 *
 * Playing a stored genome needs neither: deserialiseFaustGenome() and
 * faustGenomeToDSP() both work without initialisation, which is how the corpus
 * plays today. So this is exported for the deliberate case only — wanting a
 * non-default CPPN table size — and anyone calling it in the browser will need
 * a `process` shim in vite.config.js first.
 *
 * On table size: without initialisation CPPN_TABLE_SIZE stays at its 1024
 * default, and genomes written from now on carry their own `cppnTableSize` and
 * are emitted at it regardless. Older genomes have no recorded size, so they
 * emit at 1024 — correct for every run that used the default.
 */
export async function configureFaustSubstrate(partial = {}) {
  const { initFaustSubstrate } = await getGenomeModule();
  initFaustSubstrate(partial);
  _substrateReady = true;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const MAX_DSP_BYTES = 4 * 1024 * 1024; // a CPPN wavetable inlines as a big rdtable

/** A name superdough will accept, derived from a URL, id or label. */
export function toInstrumentName(raw, fallback = 'faust') {
  const base = String(raw || fallback)
    .split(/[?#]/)[0]
    .split('/').pop()
    .replace(/\.dsp$/i, '');
  const safe = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || fallback;
}

/**
 * Fetch a `.dsp` from a URL.
 *
 * Cross-origin fetches need CORS on the other end; a raw GitHub file works via
 * raw.githubusercontent.com, a GitHub *page* URL does not, and the error says
 * so rather than surfacing as a compile failure fifty lines later.
 */
export async function loadFaustFromUrl(url, { name } = {}) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(
      `Could not fetch ${url} — ${e.message}. Cross-origin files need CORS; ` +
      'for GitHub use the raw.githubusercontent.com URL, not the page URL.',
    );
  }
  if (!res.ok) throw new Error(`Could not fetch ${url} — HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_DSP_BYTES) {
    throw new Error(`${url} is ${(length / 1e6).toFixed(1)} MB — refusing to compile something that large`);
  }
  const source = await res.text();
  if (source.length > MAX_DSP_BYTES) {
    throw new Error(`${url} is too large to compile (${(source.length / 1e6).toFixed(1)} MB)`);
  }
  return { name: name || toInstrumentName(url), source, origin: { kind: 'url', url } };
}

/** Emit `.dsp` from a Faust-substrate genome (object or JSON string). */
export async function faustSourceFromGenome(input, { name } = {}) {
  const { isFaustGenome, deserialiseFaustGenome, faustGenomeToDSP, faustGenomeRenderHints } =
    await getGenomeModule();

  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw new Error('Genome is a string but not JSON'); }
  }
  // Genomes arrive bare or wrapped, same as in browserRender.js.
  if (raw && raw.genome) raw = raw.genome;
  if (!isFaustGenome(raw)) {
    throw new Error(
      `Not a Faust-substrate genome (substrate=${raw?.substrate ?? 'unknown'}). ` +
      'CPPN+DSP sounds play through the sample kit, not as Faust instruments.',
    );
  }

  // NO initFaustSubstrate() here. It is not needed to emit a stored genome, and
  // in the browser it throws — see configureFaustSubstrate above. Deserialising
  // allocates no innovation IDs, so this path never reaches cuid.
  const genome = deserialiseFaustGenome(raw);
  return {
    name: name || toInstrumentName(raw.seedName || raw.evolutionRunId, 'faust'),
    source: faustGenomeToDSP(genome),
    origin: {
      kind: 'genome',
      seedName: genome.seedName,
      evolutionRunId: genome.evolutionRunId,
      generationNumber: genome.generationNumber,
      hints: faustGenomeRenderHints(genome),
    },
  };
}

/**
 * Whatever the caller has, turned into { name, source, origin }.
 *
 * Accepts: { url }, { dsp }, { genome }, a bare `.dsp` string, a bare URL
 * string, or a Synth.is sound entry carrying a genome.
 */
export async function resolveFaustSource(input, { name } = {}) {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
      return loadFaustFromUrl(trimmed, { name });
    }
    // Faust source always defines `process`; without it we would be handing the
    // compiler a URL typo and reading the error backwards.
    if (/\bprocess\s*(\(|=)/.test(trimmed)) {
      return { name: name || 'faust', source: trimmed, origin: { kind: 'text' } };
    }
    throw new Error('Not a URL and not Faust source (no `process` definition)');
  }
  if (!input || typeof input !== 'object') throw new Error('Nothing to load');
  if (input.url) return loadFaustFromUrl(input.url, { name: name || input.name });
  if (input.dsp) return { name: name || input.name || 'faust', source: input.dsp, origin: { kind: 'text' } };
  if (input.genome || input.substrate) {
    return faustSourceFromGenome(input.genome || input, { name: name || input.name });
  }
  throw new Error('Unrecognised Faust input: expected { url }, { dsp } or { genome }');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// What is currently playable, for the UI and for the AI reference. Keyed by the
// normalised name superdough registered.
const INSTRUMENTS = new Map();

export function getFaustInstruments() {
  return [...INSTRUMENTS.values()];
}

export function getFaustInstrumentNames() {
  return [...INSTRUMENTS.keys()];
}

export function clearFaustInstruments() {
  INSTRUMENTS.clear();
}

/**
 * Load and register one instrument into a Strudel instance.
 *
 * `deps` decides WHICH instance. Omitted, it registers into the editor's (via
 * globalThis, after prebake) — that is the one that plays. The bounce renders
 * on the app's own instance and needs its own registration; see
 * registerFaustInstrumentsInto().
 */
export async function addFaustInstrument(input, { name, deps, origin } = {}) {
  const resolved = await resolveFaustSource(input, { name });
  const [registered] = await faustSounds({ [resolved.name]: resolved.source }, { deps });
  const info = await describeSource(resolved.source);
  const entry = {
    name: registered,
    source: resolved.source,
    // `origin` is MERGED over what the source resolved to, for two callers that
    // both know something resolveFaustSource cannot. Restoring a saved
    // composition replays the stored `.dsp`, which resolves to kind 'text' and
    // would report "pasted source" — dropping the lineage describeFaustInstruments()
    // hands the model. Adding from a sound knows the sound id, which the genome
    // itself does not carry.
    origin: origin ? { ...resolved.origin, ...origin } : resolved.origin,
    sliders: faustSliders(registered) || [],
    voice: info.voice,
    // Kept rather than discarded, because all three answer questions the UI
    // otherwise cannot: how loud is it (the corpus spans 62 dB with no level
    // policy), what range does each slider actually accept (hints that ignore
    // it clamp to a constant), and did it compile as a voice at all.
    level: info.level || null,
    io: { numInputs: info.numInputs, numOutputs: info.numOutputs },
    ranges: Object.fromEntries(
      (info.descriptors || [])
        .map((d) => {
          const label = d?.label ?? d?.name;
          if (!label) return null;
          const min = Number.isFinite(d.min) ? d.min : (Number.isFinite(d.minValue) ? d.minValue : null);
          const max = Number.isFinite(d.max) ? d.max : (Number.isFinite(d.maxValue) ? d.maxValue : null);
          return [String(label).toLowerCase(), { min, max }];
        })
        .filter(Boolean),
    ),
  };
  INSTRUMENTS.set(registered, entry);
  return entry;
}

/** Re-register everything already loaded into another Strudel instance. */
export async function registerFaustInstrumentsInto(deps) {
  if (!INSTRUMENTS.size) return [];
  const map = {};
  for (const [name, entry] of INSTRUMENTS) map[name] = entry.source;
  return faustSounds(map, { deps });
}

/**
 * One line per instrument, for the AI reference and the Concepts palette.
 *
 * The gate note is not decoration. Faust prunes every widget that reaches no
 * output, and in the current corpus a third of the elites sampled had lost
 * their `gate` — those instruments sound continuously instead of articulating,
 * so a pattern of short notes does not do what it looks like it does. The model
 * and the palette both need to know that before suggesting `.clip()`.
 */
export function describeFaustInstruments() {
  return getFaustInstruments().map((i) => {
    const where = i.origin.kind === 'genome'
      ? `evolved (${i.origin.seedName})`
      : i.origin.kind === 'url' ? 'loaded from a URL' : 'pasted source';
    const sliders = i.sliders.length ? i.sliders.join(', ') : 'none';
    const gate = i.voice?.gate === false
      ? '; DRONE (no gate widget survived compilation — it sounds continuously, note length does not articulate it)'
      : '';
    return `${i.name} — ${where}; .fp sliders: ${sliders}${gate}`;
  });
}

/** Instruments that articulate, i.e. have a surviving gate. */
export function getPlayableFaustInstruments() {
  return getFaustInstruments().filter((i) => i.voice?.gate !== false);
}

// ---------------------------------------------------------------------------
// Synth.is sounds
// ---------------------------------------------------------------------------

/**
 * Does this sound LOOK like a Faust genome?
 *
 * A DISPLAY HINT, NEVER A GATE. It reads the run id, which carries
 * `_faust-substrate_run` by naming convention from the run config — nothing
 * enforces that. Measured against the 200 sounds the browser actually loads:
 * 54 match, across four runs; 146 are CPPN+DSP; and 9 carry no usable run id at
 * all (null, or a `user_*` id from a bred sound), so this has to return false
 * without throwing rather than assume a shape.
 *
 * The truth is isFaustGenome() on the fetched genome, which
 * addFaustInstrumentFromSound applies.
 */
export function looksLikeFaustSound(sound) {
  return /faust-substrate/i.test(getEvoRunId(sound) || '');
}

/**
 * Add a Synth.is sound as a playable instrument.
 *
 * The genome comes from the recommend service, which resolves every sound type
 * by id and returns it bare (substrate at the top level) — a shape
 * faustSourceFromGenome already accepts. A CPPN+DSP sound reaches
 * isFaustGenome() and is rejected there with an explanation, rather than being
 * coerced into something that cannot be a voice.
 */
export async function addFaustInstrumentFromSound(sound, { name, deps } = {}) {
  const evoRunId = getEvoRunId(sound);
  const genome = await fetchGenome(sound.id, evoRunId);
  return addFaustInstrument({ genome }, {
    name,
    deps,
    origin: { soundId: sound.id, evoRunId: evoRunId || null, label: sound.label || null },
  });
}

/**
 * Drop an instrument from the list.
 *
 * HONEST LIMIT: superdough has no unregister, so the sound stays triggerable in
 * the page's current Strudel instances until a reload. What this does do is
 * remove it from the saved composition, from the AI reference and from the
 * re-registration that play and bounce perform — so it does not come back.
 */
export function removeFaustInstrument(name) {
  return INSTRUMENTS.delete(String(name).toLowerCase());
}

// ---------------------------------------------------------------------------
// Persistence
//
// WHAT IS SAVED IS THE EMITTED `.dsp` — NOT THE GENOME, NOT A REFERENCE.
//
// A reopened composition has to sound the same, and only the source guarantees
// that. Re-deriving DSP from a genome at open time makes the sound a function
// of whichever kromosynth is installed that day: faustGenomeToDSP, the seed
// definitions and the CPPN_TABLE_SIZE default are all live code, and no genome
// in the current corpus records its own cppnTableSize — every one of them
// depends on that default still being 1024. A reference also needs the service
// reachable and the genome still sitting where it was.
//
// It is not even the expensive option. Emitted DSP measured SMALLER than the
// genome for every corpus sound sampled — 1.1–10.3 KB against 2.5–26.3 KB, the
// large end being the ones that inline a CPPN wavetable as an rdtable.
//
// `origin` rides along as provenance: lineage for the UI and the AI reference.
// It is never what gets compiled.
// ---------------------------------------------------------------------------

/** The instrument list as it should be stored in a saved composition. */
export function serialiseFaustInstruments() {
  return getFaustInstruments().map((i) => ({
    name: i.name,
    source: i.source,
    origin: i.origin || null,
  }));
}

/**
 * Re-register a saved instrument list, replacing whatever is loaded.
 *
 * Registers under the SAVED name rather than deriving a fresh one. Names are
 * uniquified against whatever was in the kit when the sound was added, so
 * re-deriving would shift the `_2` suffixes and leave `s("…")` in the restored
 * pattern pointing at nothing.
 *
 * Waits for the editor's prebake first: registering needs a Strudel instance on
 * globalThis, and opening a composition can easily beat it there. One bad
 * instrument is collected and skipped rather than thrown — the rest of the
 * composition should still play.
 *
 * @returns {Promise<{ restored: object[], failed: string[] }>}
 */
export async function restoreFaustInstruments(saved) {
  clearFaustInstruments();
  const entries = Array.isArray(saved) ? saved.filter((e) => e?.name && e?.source) : [];
  if (!entries.length) return { restored: [], failed: [] };
  await whenStrudelScopeReady();
  const restored = [];
  const failed = [];
  for (const entry of entries) {
    try {
      restored.push(await addFaustInstrument(
        { dsp: entry.source },
        { name: entry.name, origin: entry.origin || undefined },
      ));
    } catch (err) {
      console.warn(`[faustInstruments] could not restore "${entry.name}":`, err);
      failed.push(entry.name);
    }
  }
  return { restored, failed };
}

/**
 * Expose `faust()` inside the Strudel buffer, mirroring `samples()`.
 *
 *   await faust({ bell: 'https://raw.githubusercontent.com/…/bell.dsp' })
 *   await faust('https://…/bell.dsp')          // name taken from the filename
 *   note("c3 e3").s("bell").fp({ ratio: 2 })
 *
 * A global rather than a UI panel, for the same reasons `samples()` is one: the
 * instrument list belongs to the composition, so it survives reopening the
 * buffer, it can be shared as text, the AI can write it, and there is no state
 * sitting in a side panel that the pattern silently depends on.
 *
 * It also lands in the right registry by construction. Buffer code runs inside
 * the EDITOR's Strudel instance, which is the one that has to know about the
 * sound in order to play it — no globalThis timing question, no prebake race.
 * The bounce still needs the app's instance, and gets it from
 * registerFaustInstrumentsInto(), because INSTRUMENTS lives in this module
 * regardless of who called in.
 */
export function installFaustGlobal() {
  if (typeof window === 'undefined') return false;
  const existing = window.faust;
  if (existing?.__strudelFaust) return true;
  if (existing) {
    console.warn('[faustInstruments] window.faust is already taken by something else — not overwriting. Use synthisFaust.add() instead.');
    return false;
  }
  const fn = async (input, options = {}) => {
    // A map of name -> source, vs a single descriptor. Distinguished by keys:
    // { url }, { dsp } and { genome } are descriptors, anything else is a map.
    const isDescriptor = input && typeof input === 'object'
      && (input.url || input.dsp || input.genome || input.substrate);
    if (input && typeof input === 'object' && !isDescriptor) {
      const names = [];
      for (const [name, source] of Object.entries(input)) {
        names.push((await addFaustInstrument(source, { ...options, name })).name);
      }
      return names;
    }
    return (await addFaustInstrument(input, options)).name;
  };
  fn.__strudelFaust = true;
  window.faust = fn;
  return true;
}

installFaustGlobal();

// A console handle, for testing and for anything the buffer form cannot express:
//
//   await synthisFaust.add({ dsp: '<a 0-input voice>' })
//   await synthisFaust.add('https://raw.githubusercontent.com/…/some-voice.dsp')
//   await synthisFaust.add({ genome: someFaustGenome })
//   synthisFaust.describe()
//
// NOT /faust-templates/*.dsp — those are substrate #1's 1-in/1-out EFFECTS,
// driven by CPPN excitation. registerFaustSound rejects them, because a sound
// has to generate rather than process. Only 0-input voices declaring
// freq/gain/gate can be played this way.
//
// Dev only. This is a testing affordance, not an API — nothing in the app calls
// through window, so removing it breaks nothing. Guarded on !PROD rather than on
// DEV so it also exists under `npm start`, which serves the dev server in mode
// `production-local` (live backends, local app) — a mode where DEV happens to
// still be true, but relying on that is one Vite release away from surprising.
if (typeof window !== 'undefined' && !import.meta.env?.PROD) {
  window.synthisFaust = {
    add: addFaustInstrument,
    list: getFaustInstruments,
    names: getFaustInstrumentNames,
    clear: clearFaustInstruments,
    describe: describeFaustInstruments,
    source: (name) => INSTRUMENTS.get(String(name).toLowerCase())?.source,
    configure: configureFaustSubstrate,
    // Trace the next N notes: what value superdough handed the voice, and what
    // the voice actually set on the node. This is the gap between "the hap
    // carries the parameter" and "the sound changed".
    debug: setFaustDebug,
    // Why isn't .fp doing anything? Run this. It reports which method is live
    // and what a hap actually carries, which separates "the control never
    // attached the parameter" from "the voice never applied it".
    diagnose: (instrument) => {
      const method = faustParamMethod();
      const entry = INSTRUMENTS.get(String(instrument || getFaustInstrumentNames()[0] || '').toLowerCase());
      const out = { method, instrument: entry?.name ?? null, sliders: entry?.sliders ?? null };
      if (!method) {
        out.problem = 'no Faust parameter method installed — .fp() is either absent or belongs to something else';
        return out;
      }
      if (!entry) { out.problem = 'no instrument loaded'; return out; }
      const slider = entry.sliders[0];
      if (!slider) { out.problem = 'this instrument declares no patternable sliders'; return out; }
      try {
        const pat = globalThis.note('c3').s(entry.name)[method]({ [slider]: 42 });
        out.hapValue = pat.queryArc(0, 1)[0]?.value ?? null;
        out.attached = !!out.hapValue?.faustParams;
        out.problem = out.attached ? null : `${method}() did not attach faustParams to the hap`;
      } catch (err) {
        out.problem = `building a test pattern threw: ${err.message}`;
      }
      return out;
    },
  };
}
