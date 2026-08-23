/** Shared WAV helpers (used by the on-demand renderer and the Live bounce). */

/**
 * Remove a constant DC offset by subtracting the buffer mean. Phase-free — only the
 * 0 Hz component is touched. An offset survives the edge fades and thumps when a clip
 * starts/stops, and it eats normalisation headroom asymmetrically.
 * Port of kromosynth's util/audio-buffer.js `removeDcOffset` (in place).
 */
export function removeDcOffset(buf) {
  const n = buf.length;
  if (!n) return buf;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i];
  const mean = sum / n;
  if (mean !== 0) for (let i = 0; i < n; i++) buf[i] -= mean;
  return buf;
}

/**
 * Raised-cosine (Hann) fades at both edges so the buffer starts and ends at zero.
 * Synthesis stopping at a non-zero value is an audible click; the fade-in is kept
 * short so percussive attacks survive.
 * Port of kromosynth's `ensureBufferStartsAndEndsAtZero` (in place).
 */
export function fadeEdges(buf, { fadeInSamples = 32, fadeOutSamples = 512 } = {}) {
  const half = Math.floor(buf.length / 2);
  const inLen = Math.min(fadeInSamples, half);
  const outLen = Math.min(fadeOutSamples, half);
  for (let i = 0; i < inLen; i++) buf[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / inLen));
  for (let i = 0; i < outLen; i++) {
    buf[buf.length - 1 - i] *= 0.5 * (1 - Math.cos((Math.PI * i) / outLen));
  }
  return buf;
}

/**
 * Attenuate (never boost) so nothing exceeds full scale — the render server's policy,
 * and what keeps encodeWavPcm16's clamp from turning overshoot into hard clipping.
 * Quiet buffers stay quiet: this is clip protection, not normalisation.
 */
export function protectFromClipping(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  if (peak > 1) {
    const g = 1 / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

/**
 * Delivery declick: DC-trim, edge fades, then clip protection. Applied to BROWSER-
 * rendered audio so it matches what the render server already does to its own output —
 * `removeDcOffset(summed)` + `ensureBufferStartsAndEndsAtZero(summed, {128, 512})` in
 * kromosynth-render/render-socket/src/worklet-offline-renderer.js. Without it a
 * client-rendered sound clicks at both edges where a server-rendered one doesn't.
 *
 * Clip protection comes LAST and is not optional: the render already clip-protects, so
 * peaks sit at or near 1.0, and subtracting the DC offset pushes the opposite side past
 * full scale (measured 1.17 on a real genome). encodeWavPcm16 would clamp that into
 * audible distortion.
 *
 * Delivery only — never the QD evaluation path (see the note on removeDcOffset there).
 */
export function declickForDelivery(buf) {
  removeDcOffset(buf);
  // Same lengths as the server's delivery path: 128 ≈ 2.7ms in, 512 ≈ 10.7ms out @48k.
  fadeEdges(buf, { fadeInSamples: 128, fadeOutSamples: 512 });
  return protectFromClipping(buf);
}

/** Encode mono Float32 PCM ([-1, 1]) as a 16-bit PCM WAV (Uint8Array). */
export function encodeWavPcm16(f32, sampleRate) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

/**
 * Encode one or more Float32 channels as an interleaved 16-bit PCM WAV.
 * Used by the offline (non-realtime) bounce, which renders in stereo.
 */
export function encodeWavPcm16Multi(channels, sampleRate) {
  const ch = channels.length;
  if (ch === 1) return encodeWavPcm16(channels[0], sampleRate);
  const frames = channels[0].length;
  const n = frames * ch;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  const bytesPerFrame = ch * 2;
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * bytesPerFrame, true);
  dv.setUint16(32, bytesPerFrame, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

/** Base64 of a byte array, chunked to avoid call-stack limits on large buffers. */
export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
