/**
 * schedule.js — fire a callback at a given point on the audio clock.
 *
 * WHY THIS EXISTS AT ALL. faustwasm's FaustAudioWorkletNode.setParamValue posts
 * the value over the MessagePort and sets the AudioParam only as a dead write —
 * its own source comment says "but this is not used on Processor side for now"
 * (@grame/faustwasm/src/FaustAudioWorkletNode.ts). keyOn/keyOff are postMessage
 * too. So a Faust worklet has NO sample-accurate gate: you cannot say
 * `gate.setValueAtTime(1, t)` and have it mean anything.
 *
 * Strudel hands onTrigger an absolute FUTURE time t. The only way to honour it
 * is to sit on the message until the audio clock reaches t. setTimeout drifts
 * against the audio clock and is throttled in background tabs; a
 * ConstantSourceNode's stop()/onended is driven by the audio clock itself.
 *
 * superdough has the same helper (scheduleAtTime / webAudioTimeout in
 * helpers.mjs). We deliberately do NOT reach for it through globalThis: the
 * argument order there is (callback, targetTime, audioContext) with the context
 * DEFAULTED to that instance's, which is the wrong context half the time in a
 * two-instance page, and a signature we would be silently coupled to across
 * Strudel versions. Six lines is cheaper than that coupling.
 */

/**
 * Call `onTime` when `ctx.currentTime` reaches `targetTime`.
 *
 * Returns a cancel function. Firing is best-effort: the callback runs on the
 * main thread from an onended event, so expect the main thread's scheduling
 * jitter on top of the audio clock's accuracy. Measuring exactly that is what
 * measure/ is for.
 */
export function scheduleAtTime(ctx, targetTime, onTime) {
  // Already due (or past): don't build a node for it. A ConstantSourceNode
  // stopped in the past does fire onended, but going through the graph for a
  // callback that should happen now only adds latency.
  if (targetTime <= ctx.currentTime) {
    onTime();
    return () => {};
  }

  const clock = new ConstantSourceNode(ctx, { offset: 0 });
  // Some browsers only fire onended for nodes that are connected to something
  // that pulls them, so route through a muted gain into the destination.
  const mute = new GainNode(ctx, { gain: 0 });
  clock.connect(mute);
  mute.connect(ctx.destination);

  let cancelled = false;
  clock.onended = () => {
    clock.onended = null;
    try { clock.disconnect(); } catch { /* already gone */ }
    try { mute.disconnect(); } catch { /* already gone */ }
    if (!cancelled) onTime();
  };
  clock.start(ctx.currentTime);
  clock.stop(targetTime);

  return () => { cancelled = true; };
}
