/**
 * In-browser genome rendering — the client-side alternative to the render socket.
 *
 * Runs kromosynth's batch render (CPPN activation + the asNEAT DSP graph) locally in
 * an OfflineAudioContext, so a custom duration/pitch/velocity render costs the user's
 * GPU instead of a round trip to the one shared render server. Same engine both sides:
 * `renderAudioAndSpectrogram` is exactly what kromosynth-desktop's BrowserBatchRenderer
 * calls, and what the server's worklet-offline path is built around.
 *
 * WHY BATCH, NOT STREAMING: Strudel's `samples()` needs a URL, so the complete buffer
 * has to exist before playback can start. Streaming would buy nothing here.
 *
 * Everything kromosynth is loaded via DYNAMIC import so the render engine (~200 KB of
 * lazy chunks, plus faustwasm's 7.6 MB only if a genome actually uses a Faust node)
 * stays out of the initial page load. A user who never leaves server mode never pays.
 *
 * CPPN backend: kromosynth defaults to WebGPU. Without `navigator.gpu` it falls back to
 * CPU, which works but is slow enough that server rendering is the better default —
 * see resolveRenderMode() in renderMode.js.
 */

// Resolved once, then reused. Kicked off by prewarmBrowserRenderer() when client mode
// is active so the first render isn't also paying the module-load cost.
let _renderFnPromise = null;
function getRenderFn() {
  if (!_renderFnPromise) {
    _renderFnPromise = import('kromosynth/util/render.js')
      .then((m) => m.renderAudioAndSpectrogram);
  }
  return _renderFnPromise;
}

/** Start loading the render engine in the background. Safe to call repeatedly. */
export function prewarmBrowserRenderer() {
  getRenderFn().catch(() => { /* surfaced properly on the first real render */ });
}

/** True when this browser can activate CPPNs on the GPU (WebGPU is the default backend). */
export function hasGpu() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

// A live AudioContext is needed alongside the offline one: kromosynth uses it as the
// "warm" context for GPU CPPN computation. Created lazily and kept — contexts are a
// limited resource (iOS allows only a handful), and it stays suspended when unused.
let _warmCtx = null;
function getWarmContext() {
  if (!_warmCtx || _warmCtx.state === 'closed') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    _warmCtx = new Ctx();
  }
  return _warmCtx;
}

/**
 * Genomes arrive from the recommend service in a couple of shapes: bare, or wrapped as
 * `{ _id, genome: {...} }`, with `asNEATPatch` sometimes still a JSON string. Normalise
 * to what the renderer expects. (Mirrors RenderingService.normalizeGenome in the web app.)
 */
export function normalizeGenome(genomeData) {
  let genome = genomeData;
  if (genome && genome.genome) genome = genome.genome;
  if (genome && typeof genome.asNEATPatch === 'string') {
    try {
      genome = { ...genome, asNEATPatch: JSON.parse(genome.asNEATPatch) };
    } catch {
      // Leave it — the renderer will report a clearer error than we can here.
    }
  }
  return genome;
}

/**
 * Render a Faust-substrate genome to mono Float32 audio.
 *
 * WHY THIS EXISTS: renderInBrowser fed every genome to the CPPN renderer, which
 * wants `asNEATPatch`. A Faust genome has `substrate`/`seedName`/`tree`, so it
 * failed with "Genome data missing asNEATPatch" — and since the newest public
 * discoveries are all Faust substrate, neither auditioning them nor adding them
 * to the kit worked at all. Both go through renderToWavUrl, so both are fixed
 * by branching here.
 *
 * DURATION COMES FROM THE GENOME'S OWN HINTS, not from the caller. Measured
 * against a served preview: 01M11WNQWV19WC1FR25ZQA2M53 renders to exactly
 * 2.500 s, which is its faustGenomeRenderHints().duration, while the sound
 * entry's `duration` field says 4. Auditioning at the caller's figure would
 * make the same genome sound different here and on the server — and picking
 * sounds only works if what you audition is what you get.
 *
 * NOTE: the gating policy below mirrors renderOfflineVoice in
 * packages/strudel-faust/src/voice-offline.js. That is duplication and it will
 * drift; unifying them means refactoring the verified bounce path, which is not
 * a change to make casually.
 */
async function renderFaustGenome(genome, { duration, noteDelta = 0, velocity = 1, sampleRate }) {
  const [genomeMod, faustMod] = await Promise.all([
    import('kromosynth/faust-genome/genome.js'),
    import('@kromosynth/strudel-faust'),
  ]);
  const { deserialiseFaustGenome, faustGenomeToDSP, faustGenomeRenderHints } = genomeMod;
  const { createFaustOfflineProcessor } = faustMod;

  const g = deserialiseFaustGenome(genome);
  const hints = faustGenomeRenderHints(g) || {};
  const seconds = Number.isFinite(hints.duration) ? hints.duration : (duration ?? 2);
  const BLOCK = 128;

  const proc = await createFaustOfflineProcessor(faustGenomeToDSP(g), { sampleRate, blockSize: BLOCK });
  // MANDATORY: compute() is a silent no-op until start() has run — zeros, not an error.
  proc.start();

  const paths = proc.getParams();
  const find = (s) => paths.find((p) => p === s || p.endsWith('/' + s));
  const set = (n, v) => { const p = find(n); if (p) proc.setParamValue(p, v); };
  // 440 at noteDelta 0, matching the freq widget's own declared default.
  set('freq', 440 * Math.pow(2, noteDelta / 12));
  set('gain', velocity);
  set('gate', 1);

  const total = Math.ceil(seconds * sampleRate);
  // gateOffRatio is a fraction of the note, so a pluck releases early and rings
  // out inside its own window rather than being cut off at the end.
  const gateOffAt = Number.isFinite(hints.gateOffRatio)
    ? Math.round(total * (1 - hints.gateOffRatio))
    : total;

  const samples = new Float32Array(total);
  let written = 0;
  let gateClosed = false;
  while (written < total) {
    if (!gateClosed && written >= gateOffAt) { set('gate', 0); gateClosed = true; }
    const r = proc.render(BLOCK);
    const ch = Array.isArray(r) ? r[0] : r;
    if (!ch || !ch.length) break;
    const n = Math.min(ch.length, total - written);
    for (let i = 0; i < n; i++) samples[written + i] = Number.isFinite(ch[i]) ? ch[i] : 0;
    written += n;
  }

  return { samples, sampleRate };
}

/**
 * Render a genome to mono Float32 audio in this browser.
 * Same return shape as renderViaWebSocket, so the two are interchangeable.
 *
 * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
 */
export async function renderInBrowser(rawGenome, { duration, noteDelta = 0, velocity = 1 }) {
  const genome = normalizeGenome(rawGenome);

  // Two substrates, two renderers. A Faust genome carries no asNEATPatch and the
  // CPPN renderer's failure on it is not recoverable — branch before reaching it.
  if (genome?.substrate === 'faust') {
    return renderFaustGenome(genome, {
      duration, noteDelta, velocity, sampleRate: getWarmContext().sampleRate,
    });
  }

  const renderAudioAndSpectrogram = await getRenderFn();

  const warmCtx = getWarmContext();
  const sampleRate = warmCtx.sampleRate;
  const offlineCtx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.ceil(sampleRate * duration),
    sampleRate,
  });

  // The renderer wants the asNEAT patch, not the genome wrapper, and calls toJSON() on it.
  const patch = genome.asNEATPatch || genome;
  const patchWithMethods = patch.toJSON
    ? patch
    : { ...patch, toJSON() { return this; } };

  const result = await renderAudioAndSpectrogram(
    patchWithMethods,
    genome.waveNetwork,
    duration,
    noteDelta,
    velocity,
    sampleRate,
    false, // reverse
    false, // asDataArray
    offlineCtx,
    warmCtx, // warm context for GPU CPPN computation
    false, // useOvertoneInharmonicityFactors
    true,  // useGPU
    false, // antiAliasing
    false, // frequencyUpdatesApplyToAllPathcNetworkOutputs
  );

  const audioBuffer = result && result.audioBuffer;
  if (!audioBuffer) throw new Error('Browser render produced no audio');

  // Copy out of the AudioBuffer: the caller mutates it (declick) before WAV encoding,
  // and getChannelData hands back a live view into the buffer's own storage.
  return {
    samples: new Float32Array(audioBuffer.getChannelData(0)),
    sampleRate: audioBuffer.sampleRate,
  };
}
