/**
 * tap-worklet.js — pass-through, onset timestamps, level, and sample capture.
 *
 * Four jobs, all of which have to happen on the audio thread:
 *
 *   PASS THROUGH. Whatever comes in goes out. Easy to forget, and forgetting it
 *           makes the whole page silent while every measurement still appears
 *           to work — which is exactly what happened the first time.
 *
 *   ONSET.  Report the frame of the first sample above a threshold after being
 *           armed. This is the only honest way to measure gate jitter. The
 *           faust-elites probe page (8811) reported several elites as "silent"
 *           three separate times before working out that the cause was a
 *           polling AnalyserNode sampling less than half the timeline — a
 *           measurement window artefact, not missing audio. Timestamping on the
 *           audio thread against `currentFrame` has no window to miss.
 *
 *   LEVEL.  Answer "is anything still sounding?", so the page can wait for
 *           silence before arming. Without it, a note still ringing from a
 *           previous measurement trips the threshold the instant we arm and the
 *           reported onset error is minus the entire lead time.
 *
 *   RECORD. Accumulate the input verbatim so the live worklet render can be
 *           diffed sample-for-sample against the offline one. Peak-normalised
 *           A/B listening is not a substitute: independent normalisation lets
 *           the loudest moments dominate and hides substantial differences
 *           everywhere else.
 *
 * `currentFrame`, `currentTime` and `sampleRate` are AudioWorkletGlobalScope
 * globals, not bugs.
 */

class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.threshold = 0.01;
    this.notBefore = 0;
    this.id = null;
    this.peak = 0;
    this.recording = false;
    this.chunks = [];
    this.recorded = 0;
    this.recStartFrame = 0;
    this.maxFrames = sampleRate * 30;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'arm') {
        this.armed = true;
        this.id = msg.id ?? null;
        this.threshold = msg.threshold ?? 0.01;
        // A crossing before this context time is contamination, not our note.
        this.notBefore = msg.notBefore ?? 0;
      } else if (msg.type === 'level') {
        this.port.postMessage({ type: 'level', peak: this.peak });
        this.peak = 0;
      } else if (msg.type === 'record') {
        this.recording = true;
        this.chunks = [];
        this.recorded = 0;
        this.maxFrames = Math.round((msg.maxSeconds ?? 30) * sampleRate);
      } else if (msg.type === 'stop') {
        this.recording = false;
        const total = this.recorded;
        const out = new Float32Array(total);
        let at = 0;
        for (const c of this.chunks) {
          const n = Math.min(c.length, total - at);
          out.set(c.subarray(0, n), at);
          at += n;
          if (at >= total) break;
        }
        this.chunks = [];
        // Transfer rather than copy: a 30 s capture is 5.6 MB at 48 kHz.
        this.port.postMessage(
          { type: 'recording', samples: out, sampleRate, startFrame: this.recStartFrame },
          [out.buffer],
        );
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const channel = input && input[0];

    // Pass through FIRST and unconditionally, so a bug in the measuring code
    // below can never cost audio.
    if (output) {
      for (let c = 0; c < output.length; c++) {
        const from = input && (input[c] || input[0]);
        if (from) output[c].set(from);
        else output[c].fill(0);
      }
    }

    if (!channel) return true;

    let blockPeak = 0;
    for (let i = 0; i < channel.length; i++) {
      const a = Math.abs(channel[i]);
      if (a > blockPeak) blockPeak = a;
    }
    if (blockPeak > this.peak) this.peak = blockPeak;

    if (this.armed && blockPeak > this.threshold) {
      for (let i = 0; i < channel.length; i++) {
        if (Math.abs(channel[i]) <= this.threshold) continue;
        const time = currentTime + i / sampleRate;
        if (time < this.notBefore) break;   // too early to be ours; keep waiting
        this.armed = false;
        this.port.postMessage({ type: 'onset', id: this.id, frame: currentFrame + i, time });
        break;
      }
    }

    if (this.recording && this.recorded < this.maxFrames) {
      if (this.chunks.length === 0) this.recStartFrame = currentFrame;
      this.chunks.push(new Float32Array(channel));
      this.recorded += channel.length;
    }

    return true;
  }
}

registerProcessor('sf-tap', TapProcessor);
