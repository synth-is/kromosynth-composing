/**
 * modulate.js — LFO shape math for rack parameter modulation, shared by the page
 * (offline bounce event generation) and the AudioWorklet (per-block param events).
 *
 * The math mirrors superdough's lfo-processor worklet (node_modules/superdough/worklets.mjs)
 * so `.lfo({...})` on a rack parameter behaves like `.lfo()` on a superdough control:
 *
 *   modval = pow((shape(phase, skew) + dcoffset) * depth, curve)
 *   out    = clamp(modval, dcoffset * depth, dcoffset * depth + depth)
 *   phase  = frac(t * frequency + phase0),  phase0 = frac(phaseoffset)   (per LFO start t = 0)
 *
 * and the modulator is ADDED to the parameter's base value (an AudioParam connection adds,
 * so the rack worklet does base + Σ lfo outputs). `depth` is relative to the base value
 * (0 is treated as 1, like connectLFO's currentValue), `depthabs` is absolute.
 *
 * Shapes (getModulationShapeInput): 0 tri, 1 sine, 2 ramp, 3 saw, 4 square — by index or name.
 */

export const LFO_SHAPES = ['tri', 'sine', 'ramp', 'saw', 'square'];

const SHAPE_NAMES = { tri: 0, triangle: 0, sine: 1, ramp: 2, saw: 3, square: 4 };

/** Normalize a shape config value (index 0-4 or name) to a shape index, like getModulationShapeInput. */
export function shapeIndex(shape) {
	if (typeof shape === 'number' && Number.isFinite(shape)) return ((Math.round(shape) % 5) + 5) % 5;
	return SHAPE_NAMES[String(shape).toLowerCase()] ?? 0;
}

const frac = (x) => x - Math.floor(x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** The raw [0,1] waveshape, same formulas as superdough's waveshapes. */
export function lfoWave(shape, phase, skew = 0.5) {
	switch (shapeIndex(shape)) {
		case 1: return Math.sin(2 * Math.PI * phase) * 0.5 + 0.5; // sine
		case 2: return phase; // ramp
		case 3: return 1 - phase; // saw
		case 4: return phase >= skew ? 0 : 1; // square
		case 0: default: { // tri
			const x = 1 - skew;
			if (phase >= skew) return 1 / x - phase / x;
			return phase / skew;
		}
	}
}

/**
 * The modulator output at `t` seconds after the LFO start.
 * cfg: { freq, depth, dcoffset = -0.5, shape = 0, skew = 0.5, curve = 1, phaseoffset = 0 }.
 * Returns a value in [dcoffset*depth, dcoffset*depth + depth] (pre-curve clamp bounds),
 * exactly what an lfo-processor node would emit at that time.
 */
export function lfoValue(cfg, t) {
	const freq = Number(cfg.freq) || 0;
	const depth = Number(cfg.depth ?? 1);
	const dcoffset = cfg.dcoffset ?? -0.5;
	const skew = cfg.skew ?? 0.5;
	const curve = cfg.curve ?? 1;
	const phase = frac(t * freq + frac(cfg.phaseoffset ?? 0));
	let m = (lfoWave(cfg.shape ?? 0, phase, skew) + dcoffset) * depth;
	m = Math.pow(m, curve);
	return clamp(m, dcoffset * depth, dcoffset * depth + depth);
}

/**
 * Resolve an lfo config entry (value.lfo[id] from Strudel's .lfo()) into the plain
 * worklet/offline form: concrete frequency (sync is tempo-synced), depth resolved
 * against `base` (depthabs wins; base 0 counts as 1, like connectLFO).
 */
export function resolveLfoCfg(cfg, { cps = 1, base } = {}) {
	const freq = cfg.sync != null ? Number(cfg.sync) * cps : (Number(cfg.rate) || 1);
	const b = Number.isFinite(base) ? base : 0;
	const depth = cfg.depthabs != null ? Number(cfg.depthabs) : (Number(cfg.depth ?? 1)) * (b === 0 ? 1 : b);
	return {
		kind: 'lfo',
		freq,
		depth,
		dcoffset: cfg.dcoffset ?? -0.5,
		shape: shapeIndex(cfg.shape ?? 0),
		skew: cfg.skew ?? 0.5,
		curve: cfg.curve ?? 1,
		phaseoffset: cfg.phaseoffset ?? 0,
	};
}

/**
 * The param value: base plus every active modulator's (LFO or env) output, clamped to the
 * param's [min, max] when known (meta may be null). `entries` is [{ cfg, t }] — each
 * modulator's own elapsed time. Used by the worklet per block and by the offline path
 * per rendered block.
 */
export function modulatedParamValue(base, meta, entries) {
	let v = Number.isFinite(base) ? base : 0;
	for (const { cfg, t } of entries) v += modValue(cfg, t);
	if (meta && Number.isFinite(meta.min) && Number.isFinite(meta.max)) v = clamp(v, meta.min, meta.max);
	return v;
}

/** One modulator's output at `t` seconds after its trigger. cfg.kind: 'lfo' | 'env'. */
export function modValue(cfg, t) {
	return cfg.kind === 'env' ? envValue(cfg, t) : lfoValue(cfg, t);
}

// ── envelopes (Strudel .env() on a rack param) ──────────────────────────────
//
// Mirrors superdough's envelope-processor worklet: an ADSR triggered at t=0, with
// `susTime` = sustain length (note duration — release starts at susTime). Each stage's
// phase is measured against the CUMULATIVE stage time and warped by its curve:
//   warp(p, c) = c > 0 ? 1-(1-p)^(1+8c) : p^(1-8c)      (strength 8, as in the processor)
// Output is val * depth in [0, depth] — added to the param's base (AudioParam connection).

const ENV_DEFAULTS = { a: 0.005, d: 0.14, s: 0, r: 0.1 };

function warp(phase, curvature) {
	if (phase === 0 || phase === 1) return phase;
	if (curvature > 0) return 1 - Math.pow(1 - phase, 1 + 8 * curvature);
	return Math.pow(phase, 1 - 8 * curvature);
}

/** Normalize a .env() config entry (value.env[id]) into the plain worklet/offline form. */
export function resolveEnvCfg(cfg, { base, susTime } = {}) {
	const b = Number.isFinite(base) ? base : 0;
	const depth = cfg.depthabs != null ? Number(cfg.depthabs) : (Number(cfg.depth ?? 1)) * (b === 0 ? 1 : b);
	return {
		kind: 'env',
		a: Math.max(0, Number(cfg.attack ?? cfg.a ?? ENV_DEFAULTS.a)),
		d: Math.max(0, Number(cfg.decay ?? cfg.d ?? ENV_DEFAULTS.d)),
		s: Math.min(1, Math.max(0, Number(cfg.sustain ?? cfg.s ?? ENV_DEFAULTS.s))),
		r: Math.max(0, Number(cfg.release ?? cfg.r ?? ENV_DEFAULTS.r)),
		ac: Number(cfg.acurve ?? cfg.ac ?? 0),
		dc: Number(cfg.dcurve ?? cfg.dc ?? 0),
		rc: Number(cfg.rcurve ?? cfg.rc ?? 0),
		susTime: Number.isFinite(susTime) ? susTime : 0,
		depth,
	};
}

/** Envelope output at `t` seconds after trigger (cfg from resolveEnvCfg). */
export function envValue(cfg, t) {
	if (t < 0) return 0;
	const { a, d, s, r, ac, dc, rc, susTime, depth } = cfg;
	// cumulative stage times, exactly like the processor's `states` array
	const times = [Infinity, a, a + d, susTime, susTime + r];
	const stages = [
		{ start: 0, target: 0, curve: 0 },
		{ start: 0, target: 1, curve: ac },
		{ start: 1, target: s, curve: dc },
		{ start: s, target: s, curve: 0 },
		{ start: s, target: 0, curve: rc },
	];
	let state = 1; // triggered at t=0 -> attack
	while (state < 4 && t >= times[state]) state++;
	const { start, target, curve } = stages[state];
	const time = times[state];
	let val;
	if (time === Infinity || time === 0 || start === target) val = target;
	else val = start + (target - start) * warp(Math.min(1, t / time), curve);
	return val * depth;
}
