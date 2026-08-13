/**
 * Non-realtime (offline) bounce of a live-coding pattern → WAV bytes.
 *
 * Renders through an OfflineAudioContext, faster than realtime.
 *
 * Why offline rather than recording the output:
 *   - works inside Ableton Live's embedded WebView (plain Web Audio, no
 *     getDisplayMedia / screen capture, which embedded webviews don't support)
 *   - arbitrary length: a minutes-long drone renders faster than realtime
 *   - deterministic and cycle-accurate (you specify begin/end cycles), with no
 *     dependence on tab focus or timer throttling
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT — why this doesn't call upstream's `renderPatternAudio`, and why it
 * never imports SuperdoughAudioController. Both roads lead to the same trap:
 *
 * `superdough` ships a pre-bundled `dist/index.mjs` (its package "main") AND its
 * unbundled sources. `@strudel/webaudio` imports most things from the bare
 * specifier `superdough` (→ dist) but is forced to deep-import
 * `superdough/superdoughoutput.mjs` (→ source) for `SuperdoughAudioController`,
 * because dist exports only get/setSuperdoughAudioController, not the class.
 * Installed from npm those are TWO module instances with separate module state.
 * So a controller built from the source class, handed to the dist instance,
 * mixes graphs: `setAudioContext()` sets the offline context on one instance
 * while helpers like `gainNode()` — used by the reverb/delay EFFECT SENDS — read
 * `getAudioContext()` from the other, which is unset and therefore silently
 * creates a LIVE AudioContext. Connecting that live gain node to the offline
 * reverb node throws:
 *
 *     InvalidAccessError: cannot connect to an AudioNode belonging to a
 *     different audio context
 *
 * …and every event using `room`/`delay` is dropped while dry events render fine
 * — a silently incomplete WAV, the worst kind of bug. (Strudel's monorepo
 * resolves `superdough` to the workspace source, so upstream never sees this;
 * `renderPatternAudio` from the published package hits it too.)
 *
 * Aliasing the bare specifier to the sources doesn't work either: they import
 * `./worklets.mjs?audioworklet`, a suffix provided by a custom Vite plugin in
 * Strudel's monorepo ("No matching export … for import default"). That's exactly
 * why dist exists.
 *
 * The way out: stay entirely inside the dist instance and never touch the class.
 * `getSuperdoughAudioController()` lazily builds a controller with dist's OWN
 * class on the CURRENT context — so we set the offline context, null the
 * controller, and let superdough create it itself. One instance, one graph.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  superdough,
  initAudio,
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  samples,
} from '@strudel/webaudio';
import { encodeWavPcm16Multi } from './wav.js';

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
 * @param {object}   opts.pattern   evaluated pattern (from the editor's scheduler)
 * @param {number}   opts.cps       cycles per second
 * @param {number}   opts.fromCycle start cycle (inclusive)
 * @param {number}   opts.toCycle   end cycle (exclusive)
 * @param {number}   opts.sampleRate
 * @param {number}   opts.maxPolyphony
 * @param {boolean}  opts.multiChannelOrbits
 * @param {object}   [opts.kitMap]  { name: url } registered before rendering
 * @param {(p:number)=>void} [opts.onProgress]
 * @returns {Promise<{wav, durationSecs, sampleRate, channels, skipped, total}>}
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

  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  setAudioContext(ctx);
  // Null it so superdough lazily rebuilds the controller with ITS OWN class on
  // THIS context (see the header note) — never construct one ourselves.
  setSuperdoughAudioController(null);
  // Effect/orbit nodes are cached and bound to the context that built them; clear
  // any left over from a previous render before we start.
  try { resetGlobalEffects(); } catch { /* ignore */ }

  let skipped = 0;
  let total = 0;
  try {
    await initAudio({ maxPolyphony, multiChannelOrbits });

    // The kit samples must exist in THIS instance's registry too — the editor
    // registered them in its own.
    if (kitMap && Object.keys(kitMap).length) {
      await samples(kitMap);
    }

    // Schedule in ascending onset order: controls that depend on audio-graph
    // state (e.g. `cut`) need it, and times are relative to fromCycle.
    const haps = pattern
      .queryArc(fromCycle, toCycle, { _cps: cps })
      .filter((h) => (h.hasOnset ? h.hasOnset() : !!h.whole))
      .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());
    total = haps.length;

    for (let i = 0; i < haps.length; i++) {
      const hap = haps[i];
      try {
        hap.ensureObjectValue?.();
        const onset = (hap.whole.begin.valueOf() - fromCycle) / cps;
        await superdough(hap.value, onset, hap.duration / cps, cps, onset);
      } catch (err) {
        // One bad event shouldn't abort the whole bounce, but count them so the
        // UI can warn rather than hand back a silently incomplete file.
        skipped++;
        console.warn('[bounce] skipped an event:', err, hap.value);
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
      skipped,
      total,
    };
  } finally {
    // Drop everything bound to this render's context so the next bounce is clean.
    try { resetGlobalEffects(); } catch { /* ignore */ }
    try { setSuperdoughAudioController(null); } catch { /* ignore */ }
    try { setAudioContext(null); } catch { /* ignore */ }
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
