/**
 * Bounce the current Strudel output to a WAV, in real time, via MediaRecorder.
 *
 * Tap point (verified against the installed @strudel/webaudio → superdough):
 * every voice routes through SuperdoughOutput.destinationGain before reaching
 * audioContext.destination. superdough exposes getSuperdoughAudioController(),
 * so the master node is getSuperdoughAudioController().output.destinationGain.
 * We fan that node out into a MediaStreamAudioDestinationNode (speakers keep
 * playing) and record it.
 *
 * CAVEAT: this only captures the REPL's audio if this import of
 * '@strudel/webaudio' resolves to the SAME module instance @strudel/repl uses.
 * vite.config.js forces that via resolve.dedupe; a silent recording despite
 * audible playback means two instances (see docs/ABLETON_BRIDGE.md).
 *
 * MediaRecorder yields compressed audio (webm/opus), decoded back to PCM and
 * re-encoded to WAV, so it's slightly lossy. A deterministic OfflineAudioContext
 * render is the lossless follow-up.
 */
import { getAudioContext, getSuperdoughAudioController } from '@strudel/webaudio';
import { encodeWavPcm16 } from './wav.js';

export { encodeWavPcm16, bytesToBase64 } from './wav.js';

function getMaster() {
  const ctx = getAudioContext();
  const controller = getSuperdoughAudioController();
  const master = controller?.output?.destinationGain || null;
  return { ctx, master };
}

export async function bounceToWav({ padRef, seconds = 8 } = {}) {
  const { ctx, master } = getMaster();
  if (!ctx) throw new Error('No Strudel AudioContext — play once first');
  if (!master?.connect) {
    throw new Error('Could not reach Strudel master output — check Vite dedupe (see docs/ABLETON_BRIDGE.md)');
  }
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* ignore */ } }

  const tap = ctx.createMediaStreamDestination();
  master.connect(tap); // fan-out: master still feeds ctx.destination (speakers)

  const chunks = [];
  const rec = new MediaRecorder(tap.stream);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  rec.start();
  padRef?.current?.play?.();
  await new Promise((r) => setTimeout(r, Math.max(0.5, seconds) * 1000));
  padRef?.current?.stop?.();
  rec.stop();
  await stopped;
  try { master.disconnect(tap); } catch { /* ignore */ }

  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const mono = mixToMono(decoded);
  return { wav: encodeWavPcm16(mono, decoded.sampleRate), durationSecs: decoded.duration };
}

function mixToMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  if (ch === 1) return audioBuffer.getChannelData(0);
  const n = audioBuffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i] / ch;
  }
  return out;
}
