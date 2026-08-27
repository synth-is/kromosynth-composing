/**
 * compiler.js — libfaust singleton + compiled-factory cache.
 *
 * Ported from kromosynth-desktop/packages/web/src/utils/faustBrowser.js. Kept
 * separate from the Strudel side on purpose: this module knows nothing about
 * patterns, and the Strudel side knows nothing about libfaust.
 *
 * THE INPUT IS A `.dsp` STRING, ALWAYS. No genome type, no kromosynth import.
 * kromosynth/faust-genome/genome.js already says the delivered artefact is a
 * self-contained Faust program, so consuming exactly that keeps this package
 * independently useful (and publishable) while genome deserialisation, CPPN
 * activation and slider baking stay upstream where they belong.
 *
 * WHY faustwasm ARRIVES BY URL AND NOT BY IMPORT. `@grame/faustwasm` builds its
 * AudioWorklet processor source with `${ClassName.name}` + `${ClassName
 * .toString()}`. Any bundler that minifies it renames those classes to short
 * identifiers that do not exist inside AudioWorkletGlobalScope, and production
 * dies with "ReferenceError: cA is not defined". kromosynth-composing's
 * vite.config.js therefore serves the unprocessed 7.6 MB esm-bundle at
 * /vendor/faustwasm/index.js and marks it external. A bare `import '@grame/
 * faustwasm'` here would defeat all of that, so the module is fetched from a
 * configurable URL — or injected outright, which is how a host that already
 * owns a libfaust instance (kromosynth-desktop's faustBrowser.js) hands it in
 * rather than paying for a second 7.6 MB runtime.
 */

let _faustWasmUrl = '/vendor/faustwasm/index.js';
let _FW = null;          // resolved faustwasm module namespace
let _compiler = null;    // FaustCompiler instance
let _loading = null;

// Import a URL without Vite touching it.
//
// `import(someVariable)` inside a module Vite serves gets wrapped in
// __vite__injectQuery(url, 'import'), so the browser requests
// /vendor/faustwasm/index.js?import — and serve-faustwasm's middleware compares
// req.url to '/index.js' exactly, so the query makes it fall through to a 404.
// (/* @vite-ignore */ did not prevent the wrap here.)
//
// A Function body is never parsed by Vite's import-analysis, so the URL reaches
// the network verbatim. That also keeps this to ONE module instance shared with
// anything else importing the plain URL — kromosynth's faust-bridge.js does,
// and two live copies of a 7.6 MB bundle with its own libfaust would be a
// memory and correctness problem, not just waste.
const importUrl = new Function('u', 'return import(u)');

/** Point at a different faustwasm build. Call before the first compile. */
export function setFaustWasmUrl(url) {
  if (!url) return;
  _faustWasmUrl = url;
}

/**
 * Hand in an already-loaded faustwasm.
 *
 * @param {object} FW  the module namespace (needs instantiateFaustModule,
 *                     LibFaust, FaustCompiler, Faust{Mono,Poly}DspGenerator)
 * @param {object} [compiler] an existing FaustCompiler; built from FW if absent
 */
export function setFaustWasmModule(FW, compiler) {
  _FW = FW;
  if (compiler) _compiler = compiler;
}

export async function ensureFaust() {
  if (_compiler && _FW) return { FW: _FW, compiler: _compiler };
  if (!_loading) {
    _loading = (async () => {
      const FW = _FW || await importUrl(_faustWasmUrl);
      if (!_compiler) {
        const mod = await FW.instantiateFaustModule();
        _compiler = new FW.FaustCompiler(new FW.LibFaust(mod));
      }
      _FW = FW;
      return { FW: _FW, compiler: _compiler };
    })();
  }
  return _loading;
}

// ── factory cache ───────────────────────────────────────────────────────────
// Keyed on polyphony + source, as in faustBrowser.js and on the render server.
// A pattern re-triggers the same instrument thousands of times, and a cached
// factory turns a ~100 ms compile into a node construction. LRU by re-insertion.

const FACTORY_CACHE = new Map();
let FACTORY_CACHE_MAX = 24;
let _uid = 0;

export function setFactoryCacheSize(n) {
  FACTORY_CACHE_MAX = Math.max(1, n | 0);
}

export function clearFactoryCache() {
  FACTORY_CACHE.clear();
}

export function factoryCacheStats() {
  return { size: FACTORY_CACHE.size, max: FACTORY_CACHE_MAX };
}

/**
 * Compile (or fetch from cache) a generator for this source.
 *
 * @returns {Promise<{ generator, cached: boolean, compileMs: number }>}
 */
export async function getGenerator(source, polyphony = 1) {
  const key = `${polyphony}|${source}`;
  const hit = FACTORY_CACHE.get(key);
  if (hit) {
    FACTORY_CACHE.delete(key);       // refresh recency
    FACTORY_CACHE.set(key, hit);
    return { generator: hit, cached: true, compileMs: 0 };
  }
  const { FW, compiler } = await ensureFaust();
  const generator = polyphony > 1
    ? new FW.FaustPolyDspGenerator()
    : new FW.FaustMonoDspGenerator();
  // A unique name per compile: FaustCompiler keeps a static SHA-keyed factory
  // cache on name+code+args, so a reused name hands back a stale factory.
  const name = `sf_${Date.now().toString(36)}_${_uid++}`;
  const t0 = performance.now();
  const ok = await generator.compile(compiler, name, source, '');
  const compileMs = performance.now() - t0;
  if (!ok) throw new Error(`Faust compile failed: ${compiler.getErrorMessage()}`);
  FACTORY_CACHE.set(key, generator);
  if (FACTORY_CACHE.size > FACTORY_CACHE_MAX) {
    FACTORY_CACHE.delete(FACTORY_CACHE.keys().next().value);
  }
  return { generator, cached: false, compileMs };
}

/** Warm the cache so the first note of a pattern doesn't pay the compile. */
export async function warmSource(source, polyphony = 1) {
  return getGenerator(source, polyphony);
}

/**
 * A live AudioWorkletNode for this source.
 *
 * polyphony > 1 gives a FaustPolyAudioWorkletNode with keyOn/keyOff; polyphony
 * 1 gives a mono node whose `gate` you drive yourself. The genome's own
 * `[nvoices:8]` declare is simply inert in a mono compile.
 */
export async function createFaustNode(ctx, source, { polyphony = 1 } = {}) {
  const { generator } = await getGenerator(source, polyphony);
  const node = polyphony > 1
    ? await generator.createNode(ctx, polyphony)
    : await generator.createNode(ctx);
  if (!node) throw new Error('Faust createNode returned null');
  return node;
}

/**
 * An offline processor for this source — the bounce path.
 *
 * This exists because the live path cannot serve a bounce at all: inside an
 * OfflineAudioContext the render does not advance in real time, so port
 * messages (which is how every Faust parameter moves) have no defined
 * relationship to render position and every gate would land at once. Driving
 * `compute()` in blocks instead makes the offline path BLOCK-ACCURATE, i.e.
 * strictly better than the live one, not a degraded copy of it.
 */
export async function createFaustOfflineProcessor(source, {
  sampleRate = 48000, blockSize = 128, polyphony = 1,
} = {}) {
  const { generator } = await getGenerator(source, polyphony);
  const proc = polyphony > 1
    ? await generator.createOfflineProcessor(sampleRate, blockSize, polyphony)
    : await generator.createOfflineProcessor(sampleRate, blockSize);
  if (!proc) throw new Error('Faust createOfflineProcessor returned null');
  return proc;
}

/**
 * What knobs does this instrument have?
 *
 * Built on an offline processor rather than a worklet node so it costs no
 * AudioContext and no worklet registration — an app can introspect a genome
 * before the user has clicked anything.
 *
 * Returns the raw Faust descriptors where available ({ address, label, init,
 * min, max, step, ... }), which is what makes range clamping possible without
 * the caller knowing anything about the seed.
 */
export async function describeSource(source, { polyphony = 1 } = {}) {
  const proc = await createFaustOfflineProcessor(source, { polyphony });
  const paths = typeof proc.getParams === 'function' ? proc.getParams() : [];
  const descriptors = typeof proc.getDescriptors === 'function' ? proc.getDescriptors() : [];
  const numInputs = typeof proc.getNumInputs === 'function' ? proc.getNumInputs() : 0;
  const numOutputs = typeof proc.getNumOutputs === 'function' ? proc.getNumOutputs() : 0;
  // The three names Faust's polyphonic engine binds. Their ABSENCE is
  // meaningful rather than exceptional: Faust prunes a widget that reaches no
  // output, so a mutant that deleted the envelope subtree loses `gate` and
  // drones. Report it; let the caller decide what to do about it.
  const has = (suffix) => paths.some((p) => p === suffix || p.endsWith('/' + suffix));
  return {
    paths,
    descriptors,
    numInputs,
    numOutputs,
    voice: { freq: has('freq'), gain: has('gain'), gate: has('gate') },
  };
}

/** Resolve a bare slider name ('cutMul') to its full Faust path. */
export function resolveParamPath(paths, name) {
  if (!name) return null;
  return paths.find((p) => p === name || p.endsWith('/' + name)) || null;
}
