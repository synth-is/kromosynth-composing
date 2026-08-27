/**
 * voice-live.js — one Faust worklet node per note.
 *
 * Per-note rather than one shared polyphonic node, and that is a measured
 * choice rather than a preference: node construction from a warm factory is
 * 0.10 ms median (measure/, 2026-08-27), against a 125 ms sixteenth at 120 bpm.
 * A shared poly node could not be a `registerSound` at all — superdough builds
 * a fresh effects chain per event, so one source feeding all of them would
 * stack gain — and it would cost per-note .lpf(), .pan() and .room().
 *
 * The gate is deferred to the audio clock rather than fired on arrival. Also
 * measured: firing immediately lands anywhere inside the render quantum
 * (spread 5.33 ms), while deferring through a ConstantSourceNode's onended
 * lands in the same place every time (spread 0.17 ms). Same mean either way;
 * it is the spread that is audible as sloppiness.
 */

import { createFaustNode } from './compiler.js';
import { scheduleAtTime } from './schedule.js';
import { applyParams } from './params.js';

// The MessagePort's constant lateness, subtracted before scheduling.
//
// Measured at 0.94 ms mean / 0.17 ms spread on one machine (Chrome, 48 kHz,
// macOS, 2026-08-27) — so this is a starting point, not a constant of nature.
// A constant offset is exactly what a lead corrects; the spread is what cannot
// be corrected, and 0.17 ms is comfortably under Strudel's own jitter.
let GATE_LATENCY = 0.00094;

export function setGateLatency(seconds) {
  GATE_LATENCY = Math.max(0, Number(seconds) || 0);
}

export function getGateLatency() {
  return GATE_LATENCY;
}

/**
 * Build one voice. Returns superdough's handle shape:
 * { node, nodes, stop } — see superdough/synth.mjs getOscillator for the
 * contract this has to match.
 */
export async function createLiveVoice({
  ctx, source, plan, instrument, t, value, onended, deps, options = {},
}) {
  const node = await createFaustNode(ctx, source, { polyphony: 1 });
  const set = (path, v) => node.setParamValue(path, v);

  // The note itself.
  if (plan.freq) set(plan.freq, deps.getFrequencyFromValue(value));
  if (plan.gain) {
    // Faust's `gain` widget IS the MIDI velocity binding, so velocity goes
    // here by default and the genome's own response to it is audible. Note
    // that superdough ALSO scales by velocity, so a patterned .velocity()
    // applies twice; .gain() is the single-application control. Set
    // velocityToGain: false to leave this at 1 and let superdough own level.
    const v = options.velocityToGain === false ? 1 : (value.velocity ?? 1);
    set(plan.gain, v);
  }
  applyParams(set, plan, value.faustParams, { instrument, logger: deps.logger });

  const duration = Number.isFinite(value.duration) ? value.duration : 0.25;
  const tail = Number.isFinite(options.releaseTail) ? options.releaseTail : 1.0;
  const gateOn = t - GATE_LATENCY;
  const gateOff = t + duration - GATE_LATENCY;

  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    try { node.disconnect(); } catch { /* already gone */ }
    try { node.destroy?.(); } catch { /* already gone */ }
    onended?.();
  };

  if (plan.gate) {
    scheduleAtTime(ctx, gateOn, () => set(plan.gate, 1));
    scheduleAtTime(ctx, gateOff, () => set(plan.gate, 0));
  } else {
    // Faust pruned the gate, so this instrument drones from the moment it is
    // connected. Say so once rather than letting a stuck note be a mystery.
    deps.logger?.(
      `[strudel-faust] "${instrument}" has no gate widget — it will sound for the whole note and be cut by the envelope.`,
      'warning',
    );
  }

  // Default teardown, replaced by superdough's stop() when it arrives with the
  // real end-of-release time.
  let cancelTeardown = scheduleAtTime(ctx, gateOff + tail, teardown);

  return {
    node,
    nodes: { source: [node] },
    stop: (time) => {
      cancelTeardown();
      if (plan.gate) scheduleAtTime(ctx, Math.min(gateOff, time), () => set(plan.gate, 0));
      cancelTeardown = scheduleAtTime(ctx, time + 0.05, teardown);
    },
  };
}
