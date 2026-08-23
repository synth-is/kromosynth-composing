/**
 * Non-realtime bounce of a Csound buffer → WAV bytes.
 *
 * The Strudel side had to be built by hand out of an OfflineAudioContext, with all
 * the module-instance grief lib/offlineRender.js documents. Csound renders to a
 * file natively, so this is mostly plumbing — but three things are specific enough
 * to be worth stating.
 *
 * 1. IT REUSES THE ENGINE'S AUDIOCONTEXT BUT NOT ITS INSTANCE. A second Csound
 *    instance, because the live one may be mid-performance and needs different
 *    options (`-o <file>` rather than `-odac`). But NOT a second context, and
 *    emphatically not an OfflineAudioContext: @csound/browser calls `resume()` on
 *    whatever context it is given, and an OfflineAudioContext throws "Cannot
 *    resume an offline audio context that has not started". The rejection is
 *    swallowed as an unhandled promise, the performance never runs, and Csound
 *    tears down reporting `overall amps: 0.00000` after an elapsed time of zero —
 *    leaving a valid WAV header with no samples in it. With `autoConnect: false`
 *    and output going to a file, sharing the live context is harmless: this
 *    instance never reaches the speakers.
 *
 * 2. NO KEEP-ALIVE. The realtime engine injects `f 0 86400` so a live-coding
 *    session never ends when the score runs out. Offline that would mean rendering
 *    twenty-four hours. The range is bounded by an `e <t>` statement instead.
 *
 * 3. 16-BIT ON PURPOSE (`-W -s`). Not for quality — it is so the format coming
 *    back is known, and the samples can be lifted out and re-wrapped in a header
 *    this app wrote. Csound's own header plays as zero-length in players even when
 *    the audio is all present; see rewrapWav().
 */

import { Csound } from '@csound/browser';
import { KIT_DIR, kitFilePath } from './csoundPaths.js';
import { splitCsoundCode, fetchKitBytes, getContext } from './csoundEngine.js';

const OUT_PATH = '/bounce.wav';

export const DEFAULT_CSOUND_BOUNCE = { fromSeconds: 0, toSeconds: 8, sampleRate: 48000 };

/**
 * @param {object} opts
 * @param {string} opts.code        the editor buffer (orchestra + optional score)
 * @param {number} opts.fromSeconds start of the range
 * @param {number} opts.toSeconds   end of the range
 * @param {number} opts.sampleRate
 * @param {object} [opts.kitMap]    { name: url }
 * @param {(p:number)=>void} [opts.onProgress]
 * @returns {Promise<{wav, durationSecs, sampleRate, channels, skipped, total}>}
 */
export async function renderCsoundOffline({
  code,
  fromSeconds = DEFAULT_CSOUND_BOUNCE.fromSeconds,
  toSeconds = DEFAULT_CSOUND_BOUNCE.toSeconds,
  sampleRate = DEFAULT_CSOUND_BOUNCE.sampleRate,
  kitMap,
  onProgress,
} = {}) {
  const from = Math.max(0, Number(fromSeconds) || 0);
  const to = Number(toSeconds) || 0;
  if (!(to > from)) throw new Error('End time must be after start time.');
  if (!code || !code.trim()) throw new Error('Nothing to bounce — the editor is empty.');

  const { orc, sco } = splitCsoundCode(code);
  if (!orc) throw new Error('Nothing to bounce — there is no orchestra above the score.');

  // A real, already-running context — see point 1 in the header. The sample rate
  // of the FILE comes from --sample-rate below, not from this context, because
  // the output is a file rather than the device.
  const cs = await Csound({ audioContext: getContext(), autoConnect: false });
  if (!cs) throw new Error('Could not start Csound for rendering.');

  const messages = [];
  try {
    await cs.on('message', (m) => messages.push(String(m).trim()));

    await cs.setOption(`-o${OUT_PATH}`);
    await cs.setOption('-W'); // WAV container
    await cs.setOption('-s'); // 16-bit — see the header note
    await cs.setOption('-d');
    await cs.setOption(`--sample-rate=${sampleRate}`);

    if (kitMap && Object.keys(kitMap).length) {
      try { await cs.fs.mkdir(KIT_DIR); } catch { /* already there */ }
      const bytes = await fetchKitBytes(kitMap);
      for (const [name, data] of bytes) await cs.fs.writeFile(kitFilePath(name), data);
    }

    const status = await cs.compileOrc(orc);
    if (typeof status === 'number' && status !== 0) {
      throw new Error(firstError(messages) || `Orchestra did not compile (status ${status}).`);
    }
    await cs.readScore(`${sco}\ne ${to}`);

    // WE drive the performance. This build has no `perform()` despite the type
    // definitions declaring one, and `start()` on its own renders NOTHING when the
    // output is a file: Csound goes straight from "SECTION 1" to teardown with an
    // elapsed time of zero. `performKsmps()` renders one control block per call and
    // returns non-zero when the score ends — which our `e <t>` statement guarantees.
    // The loop bound is only a backstop.
    //
    // ~12,000 calls for eight seconds of audio, about 3 s of wall time, essentially
    // all of it crossing into wasm (Csound reports `CPU: 0.000s`). The obvious
    // lever is fewer, larger calls — but `performBuffer()` is absent here too, so
    // there ISN'T one. An attempt at `-b 8192` plus performBuffer made it three
    // times SLOWER: the buffer never took effect, and polling getScoreTime for
    // progress added 750 round trips to the very queue being measured. Raising
    // ksmps would work and is not allowed — it would change the k-rate, so the
    // bounce would not match what you heard.
    //
    // Feature-detection stays, so a future build that gains performBuffer picks it
    // up for free. Progress stays a local division: it costs nothing.
    const useBuffer = typeof cs.performBuffer === 'function';
    const tick = useBuffer ? () => cs.performBuffer() : () => cs.performKsmps();
    if (!useBuffer && typeof cs.performKsmps !== 'function') {
      throw new Error('This @csound/browser build exposes no way to drive a render.');
    }

    await cs.start();

    const ksmps = Number(await cs.getKsmps()) || 32;
    const maxCalls = Math.ceil((to * sampleRate) / ksmps) + 64;
    const startedAt = performance.now();
    let calls = 0;
    onProgress?.(0);
    for (let i = 0; i < maxCalls; i++) {
      const r = await tick();
      calls++;
      if (r !== 0) break; // the `e` statement was reached
      if (onProgress && (i & 255) === 0) onProgress(i / maxCalls);
    }
    onProgress?.(1);
    console.log(`[csound-bounce] ${calls} × ${useBuffer ? 'performBuffer' : 'performKsmps'}`
      + ` in ${Math.round(performance.now() - startedAt)} ms for ${to}s of audio`);

    // Close the file before reading it: a WAV's header carries the data size, and
    // that is written when the file is closed. Reading early gets a header that
    // claims zero samples.
    try { await cs.stop(); } catch { /* already stopped */ }
    try { await cs.cleanup?.(); } catch { /* optional */ }

    let raw = await readOut(cs);
    if (!hasAudio(raw)) {
      // Some builds only flush the header on a full reset rather than on cleanup.
      try { await cs.reset(); } catch { /* ignore */ }
      const retry = await readOut(cs);
      if (hasAudio(retry)) raw = retry;
    }

    // Csound announces which output it opened, so these messages settle the
    // question an empty file leaves open: did it render to /bounce.wav at all, or
    // did it go to the audio graph? Logged either way — they are the only
    // window into what the render actually did.
    console.log('[csound-bounce] file bytes:', raw ? raw.length : 0,
      '| header:', raw ? parseWavHeader(raw) : null);
    console.log('[csound-bounce] csound said:\n' + messages.join('\n'));

    if (!raw || raw.length < 44) {
      throw new Error(firstError(messages) || 'The render produced no file at all.');
    }
    return trimToRange(raw, from, to);
  } finally {
    try { await cs.terminateInstance?.(); } catch { /* best effort */ }
  }
}

async function readOut(cs) {
  try { return await cs.fs.readFile(OUT_PATH); } catch { return null; }
}

function hasAudio(raw) {
  if (!raw || raw.length < 44) return false;
  const h = parseWavHeader(raw);
  return !!h && h.dataBytes > 0;
}

function firstError(messages) {
  const hit = messages.find((t) => t && !/^warning:/i.test(t)
    && (/^sread:/i.test(t) || /\bsyntax error\b/i.test(t) || /unable to find opcode/i.test(t)
      || /parsing failed|stopping on parser failure/i.test(t) || /\berror:/i.test(t)));
  return hit ? hit.replace(/\s+/g, ' ').slice(0, 200) : null;
}

function parseWavHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < 44) return null;
  if (dv.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
  if (dv.getUint32(8, false) !== 0x57415645) return null; // 'WAVE'
  const riffSize = dv.getUint32(4, true);
  let off = 12;
  let channels = null; let rate = null; let bits = null;
  let dataOffset = null; let dataBytes = null;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 0x666d7420 && body + 16 <= dv.byteLength) {          // 'fmt '
      channels = dv.getUint16(body + 2, true);
      rate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === 0x64617461) {                                  // 'data'
      dataOffset = body;
      dataBytes = Math.min(size, dv.byteLength - body);
    }
    off = body + size + (size % 2);
  }
  if (!channels || !rate || !bits || dataOffset == null) return null;
  return { channels, sampleRate: rate, bits, dataOffset, dataBytes, riffSize, fileBytes: bytes.length };
}

/**
 * Copy the PCM out and put a canonical 44-byte header in front of it.
 *
 * Csound's own file plays as zero-length in players even though the data is all
 * there — libsndfile patches size fields and appends metadata chunks on close, and
 * something in that layout isn't what a player expects. Rather than work out which
 * field is wrong, take the samples (which we know are right) and write a header we
 * control. Copying bytes rather than decoding to float and re-encoding keeps it
 * bit-exact: a round trip through Float32 would shift every positive sample by one,
 * because 32768 is the scale going down and 32767 coming back up.
 */
function rewrapWav(raw, h, startFrame, frames) {
  const bytesPerFrame = h.channels * (h.bits / 8);
  const dataStart = h.dataOffset + startFrame * bytesPerFrame;
  const dataLen = frames * bytesPerFrame;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);                                  // PCM
  dv.setUint16(22, h.channels, true);
  dv.setUint32(24, h.sampleRate, true);
  dv.setUint32(28, h.sampleRate * bytesPerFrame, true);
  dv.setUint16(32, bytesPerFrame, true);
  dv.setUint16(34, h.bits, true);
  tag(36, 'data'); dv.setUint32(40, dataLen, true);
  out.set(raw.subarray(dataStart, dataStart + dataLen), 44);
  return out;
}

/** Take the requested range and hand back a WAV with a header we wrote. */
function trimToRange(raw, from, to) {
  const h = parseWavHeader(raw);
  if (!h) throw new Error('Csound wrote a file this app could not parse.');
  const bytesPerFrame = h.channels * (h.bits / 8);
  const available = Math.min(h.dataBytes, raw.length - h.dataOffset);
  const totalFrames = Math.floor(available / bytesPerFrame);
  if (totalFrames <= 0) {
    throw new Error('Csound wrote the file but no samples — see the console for what it reported.');
  }
  const startFrame = Math.min(totalFrames, Math.round(from * h.sampleRate));
  // Clamp to what was ASKED for: Csound flushes whole output buffers, so the file
  // can run slightly past the `e` statement. Without this an 8 s bounce came back
  // as 8.043 s.
  const wanted = Math.round((to - from) * h.sampleRate);
  const frames = Math.min(totalFrames - startFrame, wanted);
  if (frames <= 0) throw new Error('That range starts after the end of the render.');

  return {
    wav: rewrapWav(raw, h, startFrame, frames),
    durationSecs: frames / h.sampleRate,
    sampleRate: h.sampleRate,
    channels: h.channels,
    skipped: 0,
    total: 0,
  };
}
