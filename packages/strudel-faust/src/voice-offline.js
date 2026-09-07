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
import { applyParams, voiceFrequency } from './params.js';

const BLOCK = 128;

// Truncation is a property of the INSTRUMENT, not of each note, so it is
// reported once per instrument. Warning per note would put one line per event
// in the console during a bounce — the same flood that faustwasm's own
// per-node logging caused, and the reason silenceFaustNodeLogs exists.
const truncationWarned = new Set();

export function resetTruncationWarnings() {
  truncationWarned.clear();
}

/**
 * Render one note and hand superdough an AudioBufferSourceNode.
 *
 * A buffer source is the right shape here for a reason beyond convenience:
 * it schedules sample-accurately with start(t), so the offline path has no
 * gate latency to compensate and no jitter to measure.
 *
 * A gate-less genome — Faust pruned the widget because it reached no output —
 * never stops on its own. It gets rendered to the cap and faded; superdough's
 * own envelope then shapes it into a note. That is the honest behaviour for an
 * instrument that has lost its articulation, and it is not rare in this corpus.
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
  // voiceFrequency, not deps.getFrequencyFromValue: a bare s("x") with no
  // note() must sound at the pitch it was previewed at. See params.js.
  if (plan.freq) set(plan.freq, voiceFrequency(value, deps));
  // plan.trim: same attenuation as the live path, so a bounce matches playback.
  if (plan.gain) set(plan.gain,
    (options.velocityToGain === false ? 1 : (value.velocity ?? 1))
    * (Number.isFinite(plan.trim) ? plan.trim : 1));
  applyParams(set, plan, value.faustParams, { instrument, logger: deps.logger });
  if (plan.gate) set(plan.gate, 1);

  const duration = Number.isFinite(value.duration) ? value.duration : 0.25;
  const maxTail = Number.isFinite(options.maxTail) ? options.maxTail : 1.5;
  const gateOffAt = Math.round(duration * sampleRate);
  const hardLimit = Math.round((duration + maxTail) * sampleRate);
  // Silence RELATIVE to the note's own peak, not an absolute floor.
  //
  // An absolute 1e-4 never fires on this corpus: evolved resonators ring, and
  // a third of the sampled elites lost their gate entirely and simply never
  // stop. Every note then rendered to the full cap, so a 64-note pattern cost
  // minutes of bouncing. Measuring decay against the note's own peak stops when
  // the tail is inaudible in context, which is what "finished" actually means.
  const silenceRatio = options.silenceRatio ?? 1e-3;          // -60 dB of peak
  const silentBlocksNeeded = Math.ceil(0.05 * sampleRate / BLOCK);

  // Render until the tail actually decays rather than to a fixed length: a
  // pluck genome and a genome with a four-second reverb should not cost the
  // same, and truncating the second one is an audible edit.
  const chunks = [];
  const out = [new Float32Array(BLOCK)];
  let written = 0;
  let released = false;
  let silentBlocks = 0;
  let notePeak = 0;
  let truncated = false;
  while (written < hardLimit) {
    if (plan.gate && !released && written >= gateOffAt) { set(plan.gate, 0); released = true; }
    proc.compute([], out);
    chunks.push(new Float32Array(out[0]));
    written += BLOCK;

    let peak = 0;
    for (let i = 0; i < BLOCK; i++) {
      const a = Math.abs(out[0][i]);
      if (a > peak) peak = a;
    }
    if (peak > notePeak) notePeak = peak;

    if (released) {
      silentBlocks = peak < notePeak * silenceRatio ? silentBlocks + 1 : 0;
      if (silentBlocks >= silentBlocksNeeded) break;
    }
  }
  truncated = written >= hardLimit;
  proc.stop();
  proc.destroy?.();

  const total = chunks.length * BLOCK;
  const buffer = ctx.createBuffer(1, Math.max(1, total), sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < chunks.length; i++) channel.set(chunks[i], i * BLOCK);

  // Still sounding when the cap arrived — a drone, or a very long tail. Cutting
  // a non-zero waveform mid-cycle is an audible click in the bounced file, so
  // fade the last few milliseconds instead. superdough applies its own envelope
  // on top, but it cannot rescue a discontinuity that is already in the buffer.
  if (truncated && total > 0) {
    const fade = Math.min(total, Math.round(0.02 * sampleRate));
    for (let i = 0; i < fade; i++) {
      channel[total - fade + i] *= 1 - i / fade;
    }
    if (!truncationWarned.has(instrument)) {
      truncationWarned.add(instrument);
      deps.logger?.(
        `[strudel-faust] "${instrument}" does not decay within ${maxTail}s — bounced notes are truncated and faded. `
        + 'Pass maxTail if the tail matters.',
        'warning',
      );
    }
  }

  const node = new AudioBufferSourceNode(ctx, { buffer });
  node.onended = () => onended?.();
  node.start(t);

  return {
    node,
    nodes: { source: [node] },
    stop: (time) => { try { node.stop(time); } catch { /* already stopped */ } },
  };
}
