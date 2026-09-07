/**
 * params.js — turning a compiled instrument's widgets into something a pattern
 * can safely address.
 *
 * Everything here exists because the instruments are EVOLVED. Two elites from
 * the same run do not necessarily have the same sliders: Faust prunes any
 * widget that reaches no output, so a structural mutant that dropped its
 * envelope subtree genuinely has no `gate`, and one that dropped a filter has
 * no `cutMul`. A pattern written against one elite has to degrade against
 * another, not stop.
 */

/**
 * Index a compiled instrument's widgets by bare name.
 *
 * Faust addresses are paths (`/name/cutMul`); patterns address them by the
 * label the seed declared. `getDescriptors()` carries min/max/init straight
 * from the compiled JSON, which is what makes clamping possible without the
 * caller knowing anything about the seed.
 */
export function buildParamPlan({ paths = [], descriptors = [] }) {
  const byName = new Map();
  for (const d of descriptors) {
    const label = d?.label ?? d?.name;
    if (!label) continue;
    const address = d.address ?? d.name ?? null;
    const path = address && paths.includes(address)
      ? address
      : paths.find((p) => p === label || p.endsWith('/' + label)) || address;
    if (!path) continue;
    byName.set(String(label).toLowerCase(), {
      label,
      path,
      min: Number.isFinite(d.min) ? d.min : (Number.isFinite(d.minValue) ? d.minValue : null),
      max: Number.isFinite(d.max) ? d.max : (Number.isFinite(d.maxValue) ? d.maxValue : null),
      init: Number.isFinite(d.init) ? d.init : (Number.isFinite(d.defaultValue) ? d.defaultValue : null),
    });
  }
  // Fall back to the raw path list for anything the descriptors missed, so a
  // widget is still reachable (just unclamped) rather than invisible.
  for (const p of paths) {
    const label = p.split('/').pop();
    const key = label.toLowerCase();
    if (!byName.has(key)) byName.set(key, { label, path: p, min: null, max: null, init: null });
  }
  return {
    byName,
    // The three names Faust's polyphonic engine binds. Held separately because
    // they are the note, not parameters: they come from `note`/`freq`, from
    // velocity, and from the hap's duration.
    freq: byName.get('freq')?.path ?? null,
    gain: byName.get('gain')?.path ?? null,
    gate: byName.get('gate')?.path ?? null,
  };
}

/**
 * Headroom target for a single voice, as a peak amplitude.
 *
 * Evolved genomes arrive at wildly different levels — one measured peak 0.40,
 * another 3.42, a third was inaudible. Worse, notes overlap: every voice rings
 * for releaseTail past its note, so three can sound at once and sum. Playing a
 * bare pattern therefore distorted until the user hand-tuned .gain() per
 * instrument, which is a thing nobody should have to do twice.
 *
 * 0.25 leaves room for roughly four simultaneous voices before full scale.
 * Applied through the Faust `gain` widget, which is clamped 0..1 — so this can
 * only ever ATTENUATE, needs no change to the audio graph, and lands identically
 * on the live and offline paths, preserving their sample-identical property.
 *
 * Derived from `source` alone, so it is stable across reloads without being
 * serialised: same DSP, same probe, same trim.
 */
export const TARGET_PEAK = 0.25;

export function trimForLevel(level) {
  const peak = level?.peak;
  if (!Number.isFinite(peak) || peak <= 0) return 1;
  return Math.min(1, TARGET_PEAK / peak);
}

/** Names a pattern may address with .fp() — the note's own widgets excluded. */
export const RESERVED = new Set(['freq', 'gain', 'gate']);

/**
 * The pitch these genomes are rendered and previewed at.
 *
 * WHY NOT JUST deps.getFrequencyFromValue: with no note() in the pattern,
 * superdough falls back to its own default, which sits far below the 440 Hz
 * renderFaustGenome uses (`440 * 2^(noteDelta/12)`, noteDelta 0). That broke the
 * one property that makes browsing usable — what you audition is what you get —
 * in two ways at once: bare s("x") played at the wrong pitch AND at the wrong
 * level, because level on this corpus moves as much as 38 dB between c3 and a4.
 *
 * An explicit note or freq still wins. Bare s("x") now means "as previewed".
 */
export const RENDER_REFERENCE_HZ = 440;

export function voiceFrequency(value, deps) {
  if (value?.freq == null && value?.note == null && value?.n == null) {
    return RENDER_REFERENCE_HZ;
  }
  return deps.getFrequencyFromValue(value);
}

export function patternableNames(plan) {
  return [...plan.byName.keys()].filter((k) => !RESERVED.has(k));
}

function clamp(entry, v) {
  let out = Number(v);
  if (!Number.isFinite(out)) return null;
  if (entry.min != null && out < entry.min) out = entry.min;
  if (entry.max != null && out > entry.max) out = entry.max;
  return out;
}

const warned = new Set();

function warnOnce(key, message, logger) {
  if (warned.has(key)) return;
  warned.add(key);
  (logger || ((m) => console.warn(m)))(message, 'warning');
}

export function resetParamWarnings() {
  warned.clear();
}

/**
 * Apply a hap's `faustParams` to an instrument.
 *
 * @param set   (path, value) => void — worklet node or offline processor
 * @param plan  from buildParamPlan
 * @param params the hap's faustParams object
 *
 * Unknown names warn once and are ignored rather than throwing: see the note at
 * the top of this file. Values clamp to the widget's declared range, because a
 * genome was evaluated within that range and driving outside it is not
 * something to discover during a set — `ve.moog_vcf` going non-finite inside
 * its declared range is already a known hazard in this substrate.
 */
export function applyParams(set, plan, params, { instrument = '?', logger } = {}) {
  const applied = [];
  if (!params) return applied;
  for (const [rawName, rawValue] of Object.entries(params)) {
    const name = String(rawName).toLowerCase();
    if (RESERVED.has(name)) {
      warnOnce(
        `${instrument}:reserved:${name}`,
        `[strudel-faust] .fp('${rawName}') ignored on "${instrument}": freq, gain and gate are the note — use note()/velocity/hap duration.`,
        logger,
      );
      continue;
    }
    const entry = plan.byName.get(name);
    if (!entry) {
      warnOnce(
        `${instrument}:unknown:${name}`,
        `[strudel-faust] "${instrument}" has no slider "${rawName}" — ignoring. It has: ${patternableNames(plan).join(', ') || '(none)'}`,
        logger,
      );
      continue;
    }
    const v = clamp(entry, rawValue);
    if (v == null) {
      warnOnce(
        `${instrument}:nan:${name}`,
        `[strudel-faust] .fp('${rawName}') on "${instrument}" got a non-numeric value — ignoring.`,
        logger,
      );
      continue;
    }
    set(entry.path, v);
    applied.push([entry.label, v, entry.path]);
  }
  return applied;
}
