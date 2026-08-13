/**
 * Non-realtime (offline) bounce of a live-coding pattern → WAV bytes.
 *
 * Strudel gained non-realtime export in `@strudel/webaudio` (renderPatternAudio,
 * merged upstream 2025-12-19 and present in 1.3.0): it renders through an
 * OfflineAudioContext, faster than realtime. We deliberately do NOT call
 * renderPatternAudio directly, because it triggers a browser download and returns
 * nothing — we need the bytes (for "→ Live" as well as "Download"). So this
 * reimplements the same ~40-line approach using the primitives superdough
 * exports, and returns the WAV instead.
 *
 * Why offline rather than recording the output:
 *   - works inside Ableton Live's embedded WebView (plain Web Audio, no
 *     getDisplayMedia / screen-capture, which embedded webviews don't support)
 *   - arbitrary length: a minutes-long drone renders faster than realtime
 *     instead of being played through in real time
 *   - deterministic and cycle-accurate (you specify begin/end cycles), with no
 *     dependence on tab focus or timer throttling
 *   - it needs nothing from the editor's own (separately bundled) audio engine
 *
 * NOTE ON ISOLATION: we render on OUR imported superdough instance with our own
 * OfflineAudioContext. The `<strudel-editor>` web component bundles its own copy
 * of superdough with its own AudioContext, so this does not disturb live
 * playback — we only borrow the *pattern object* from the editor and query it.
 */

import {
  superdough,
  initAudio,
  getAudioContext,
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  samples,
} from '@strudel/webaudio';
import { encodeWavPcm16Multi } from './wav.js';

// SuperdoughAudioController lives in a subpath that superdough's index doesn't
// re-export, so it's imported lazily: a resolution problem then fails the bounce
// with a clear message instead of breaking the whole app at load time.
let _Controller = null;
async function getController() {
  if (_Controller) return _Controller;
  const mod = await import('superdough/superdoughoutput.mjs');
  _Controller = mod.SuperdoughAudioController;
  if (!_Controller) throw new Error('Offline rendering is unavailable: superdough audio controller not found.');
  return _Controller;
}

export const DEFAULT_BOUNCE = {
  fromCycle: 0,
  toCycle: 4,
  sampleRate: 48000,
  maxPolyphony: 1024,
  multiChannelOrbits: false,
};

/**
 * Render `pattern` offline and return the WAV bytes.
 *
 * @param {object}   opts
 * @param {object}   opts.pattern   evaluated Strudel pattern (from the editor)
 * @param {number}   opts.cps       cycles per second (the pattern's tempo)
 * @param {number}   opts.fromCycle start cycle (inclusive)
 * @param {number}   opts.toCycle   end cycle (exclusive)
 * @param {number}   opts.sampleRate
 * @param {number}   opts.maxPolyphony
 * @param {boolean}  opts.multiChannelOrbits
 * @param {object}   [opts.kitMap]  sample map to register before rendering
 *                                  ({ name: url }), i.e. the composing kit
 * @param {(p:number)=>void} [opts.onProgress] 0..1 while scheduling events
 * @returns {Promise<{wav: Uint8Array, durationSecs: number, sampleRate: number, channels: number}>}
 */
export async function renderPatternOffline({
  pattern,
  cps,
  fromCycle = DEFAULT_BOUNCE.fromCycle,
  toCycle = DEFAULT_BOUNCE.toCycle,
  sampleRate = DEFAULT_BOUNCE.sampleRate,
  maxPolyphony = DEFAULT_BOUNCE.maxPolyphony,
  multiChannelOrbits = DEFAULT_BOUNCE.multiChannelOrbits,
  kitMap,
  onProgress,
}) {
  if (!pattern) throw new Error('Nothing to bounce — press Play once so there is a pattern to render.');
  if (!(cps > 0)) throw new Error('Could not read the tempo (cps) from the editor.');
  const cycles = toCycle - fromCycle;
  if (!(cycles > 0)) throw new Error('End cycle must be greater than start cycle.');

  const frames = Math.ceil((cycles / cps) * sampleRate);
  if (!Number.isFinite(frames) || frames <= 0) throw new Error('Invalid bounce length.');

  // Keep whatever context our instance had, so a bounce leaves it as it found it.
  let previous = null;
  try { previous = getAudioContext(); } catch { /* none yet */ }

  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  const Controller = await getController();
  setAudioContext(ctx);
  setSuperdoughAudioController(new Controller(ctx));

  try {
    await initAudio({ maxPolyphony, multiChannelOrbits });

    // The kit samples must exist in THIS instance's registry too — the editor
    // registered them in its own.
    if (kitMap && Object.keys(kitMap).length) {
      await samples(kitMap);
    }

    // Schedule every event in ascending onset order: controls that depend on the
    // audio-graph state (e.g. `cut`) need it, and times are relative to fromCycle.
    const haps = pattern
      .queryArc(fromCycle, toCycle, { _cps: cps })
      .filter((h) => h.hasOnset?.() ?? !!h.whole)
      .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

    for (let i = 0; i < haps.length; i++) {
      const hap = haps[i];
      try {
        hap.ensureObjectValue?.();
        const onset = (hap.whole.begin.valueOf() - fromCycle) / cps;
        await superdough(hap.value, onset, hap.duration / cps, cps, onset);
      } catch (err) {
        // One bad event shouldn't abort the whole bounce (matches upstream).
        console.warn('[bounce] skipped an event:', err);
      }
      if (onProgress && (i % 25 === 0 || i === haps.length - 1)) {
        onProgress(haps.length ? (i + 1) / haps.length : 1);
      }
    }

    const buffer = await ctx.startRendering();
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    return {
      wav: encodeWavPcm16Multi(channels, buffer.sampleRate),
      durationSecs: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
    };
  } finally {
    // Rendering swaps global audio state; put it back so later bounces are clean.
    try { setSuperdoughAudioController(previous && _Controller ? new _Controller(previous) : null); } catch { /* ignore */ }
    try { setAudioContext(previous || null); } catch { /* ignore */ }
    try { resetGlobalEffects(); } catch { /* ignore */ }
  }
}

/** Trigger a browser download of rendered WAV bytes. */
export function downloadWav(bytes, filename) {
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `${new Date().toISOString()}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
