/**
 * voice-offline.js — the bounce backend.
 *
 * NOT a fallback. `docs/ABLETON_BRIDGE.md` option B renders the clip that
 * reaches Ableton through an OfflineAudioContext, and inside one the render
 * does not advance in real time — port messages, which is how every Faust
 * parameter moves, have no defined relationship to render position, so every
 * gate in a worklet would land at once. Driving `compute()` in blocks instead
 * puts the gate on a known block boundary.
 *
 * Measured 2026-08-27: at a matched sample rate this path is sample-identical
 * to the live worklet (peak ratio 1.000, diff rms 0). The bounce is not close
 * to what was played, it is the same samples. At a MISMATCHED rate it will not
 * be — Faust recomputes its constants per rate — so a 44.1 kHz bounce of a
 * 48 kHz session is a different render of the same instrument, by design.
 */

import { createFaustOfflineProcessor } from './compiler.js';
import { applyParams } from './params.js';

const BLOCK = 128;

/**
 * Render one note and hand superdough an AudioBufferSourceNode.
 *
 * A buffer source is the right shape here for a reason beyond convenience:
 * it schedules sample-accurately with start(t), so the offline path has no
 * gate latency to compensate and no jitter to measure.
 */
export async function renderOfflineVoice({
  ctx, source, plan, instrument, t, value, onended, deps, options = {},
}) {
  const sampleRate = ctx.sampleRate;
  const proc = await createFaustOfflineProcessor(source, { sampleRate, blockSize: BLOCK });
  // MANDATORY: FaustWebAudioDsp.compute() is a no-op until start() has run and
  // it fails silently — a buffer of zeros, not an error.
  proc.start();

  const set = (path, v) => proc.setParamValue(path, v);
  if (plan.freq) set(plan.freq, deps.getFrequencyFromValue(value));
  if (plan.gain) set(plan.gain, options.velocityToGain === false ? 1 : (value.velocity ?? 1));
  applyParams(set, plan, value.faustParams, { instrument, logger: deps.logger });
  if (plan.gate) set(plan.gate, 1);

  const duration = Number.isFinite(value.duration) ? value.duration : 0.25;
  const maxTail = Number.isFinite(options.maxTail) ? options.maxTail : 4;
  const gateOffAt = Math.round(duration * sampleRate);
  const hardLimit = Math.round((duration + maxTail) * sampleRate);
  const silenceThreshold = options.silenceThreshold ?? 1e-4;
  const silentBlocksNeeded = Math.ceil(0.05 * sampleRate / BLOCK);

  // Render until the tail actually decays rather than to a fixed length: a
  // pluck genome and a genome with a four-second reverb should not cost the
  // same, and truncating the second one is an audible edit.
  const chunks = [];
  const out = [new Float32Array(BLOCK)];
  let written = 0;
  let released = false;
  let silentBlocks = 0;
  while (written < hardLimit) {
    if (plan.gate && !released && written >= gateOffAt) { set(plan.gate, 0); released = true; }
    proc.compute([], out);
    chunks.push(new Float32Array(out[0]));
    written += BLOCK;

    if (released) {
      let peak = 0;
      for (let i = 0; i < BLOCK; i++) {
        const a = Math.abs(out[0][i]);
        if (a > peak) peak = a;
      }
      silentBlocks = peak < silenceThreshold ? silentBlocks + 1 : 0;
      if (silentBlocks >= silentBlocksNeeded) break;
    }
  }
  proc.stop();
  proc.destroy?.();

  const total = chunks.length * BLOCK;
  const buffer = ctx.createBuffer(1, Math.max(1, total), sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < chunks.length; i++) channel.set(chunks[i], i * BLOCK);

  const node = new AudioBufferSourceNode(ctx, { buffer });
  node.onended = () => onended?.();
  node.start(t);

  return {
    node,
    nodes: { source: [node] },
    stop: (time) => { try { node.stop(time); } catch { /* already stopped */ } },
  };
}
