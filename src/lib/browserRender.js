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
 * Render a genome to mono Float32 audio in this browser.
 * Same return shape as renderViaWebSocket, so the two are interchangeable.
 *
 * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
 */
export async function renderInBrowser(rawGenome, { duration, noteDelta = 0, velocity = 1 }) {
  const genome = normalizeGenome(rawGenome);
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
