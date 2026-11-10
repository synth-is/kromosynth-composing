// node-tests.mjs — node-side tests for the rack-param modulation (.rp()/.lfo() targets):
//   1. modulate.js LFO math against superdough's waveshape reference values
//   2. resolveRackTarget() against the bundled test rack (synth-fx-rack.wclap-rack.tar.gz)
//   3. offline renderRack with paramEvents (the LFO event stream the offline path generates)
//      and with a static per-hap param — output must differ from the unmodulated render
// Run: node test/node-tests.mjs   (from packages/strudel-rack)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lfoWave, lfoValue, envValue, resolveLfoCfg, resolveEnvCfg, modulatedParamValue, shapeIndex } from '../src/modulate.js';
import { resolveRackTarget, listRackTargets, loadRackBundle, renderRack } from '../src/index.js';
import { describeBundle, fingerprint } from '../src/vendor/wclap-rack/index.mjs';

// loadRackBundle fetch()es the URL — teach node's fetch file:// URLs for the test
const origFetch = globalThis.fetch;
globalThis.fetch = async (u, ...rest) =>
	String(u).startsWith('file://') ? new Response(fs.readFileSync(fileURLToPath(u))) : origFetch(u, ...rest);

const bundleUrl = pathToFileURL(new URL('./assets/synth-fx-rack.wclap-rack.tar.gz', import.meta.url).pathname).href;

let passed = 0;
const ok = (name) => { passed++; console.log('ok -', name); };

// ── 1. LFO math (reference: superdough/worklets.mjs waveshapes + LFOProcessor.process) ──
assert.equal(shapeIndex(1), 1);
assert.equal(shapeIndex('sine'), 1);
assert.equal(shapeIndex('saw'), 3);
assert.equal(shapeIndex(7), 2); // 7 % 5 = 2 (ramp)
// tri, skew 0.5: phase 0 -> 0, 0.25 -> 0.5, 0.5 -> 1, 0.75 -> 0.5
assert.ok(Math.abs(lfoWave(0, 0) - 0) < 1e-9);
assert.ok(Math.abs(lfoWave(0, 0.25) - 0.5) < 1e-9);
assert.ok(Math.abs(lfoWave(0, 0.5) - 1) < 1e-9);
assert.ok(Math.abs(lfoWave(0, 0.75) - 0.5) < 1e-9);
// sine: phase 0 -> 0.5, 0.25 -> 1
assert.ok(Math.abs(lfoWave(1, 0) - 0.5) < 1e-9);
assert.ok(Math.abs(lfoWave(1, 0.25) - 1) < 1e-9);
// ramp/saw/square
assert.equal(lfoWave(2, 0.3), 0.3);
assert.equal(lfoWave(3, 0.3), 0.7);
assert.equal(lfoWave(4, 0.3, 0.5), 1);
assert.equal(lfoWave(4, 0.7, 0.5), 0);
// lfoValue: default dcoffset -0.5, depth d — output is centered: at sine phase 0 -> 0
{
	const cfg = { freq: 1, depth: 2, dcoffset: -0.5, shape: 1, skew: 0.5, curve: 1, phaseoffset: 0 };
	assert.ok(Math.abs(lfoValue(cfg, 0) - 0) < 1e-9); // sine(0)=0.5 -> (0.5-0.5)*2 = 0
	assert.ok(Math.abs(lfoValue(cfg, 0.25) - 1) < 1e-9); // sine=1 -> (1-0.5)*2 = 1
	assert.ok(Math.abs(lfoValue(cfg, 0.75) + 1) < 1e-9); // sine=0 -> -1
}
// resolveLfoCfg: sync is tempo-synced, depth relative to base (0 counts as 1), depthabs wins
{
	assert.equal(resolveLfoCfg({ sync: 2 }, { cps: 0.5 }).freq, 1);
	assert.equal(resolveLfoCfg({ rate: 3 }, { cps: 0.5 }).freq, 3);
	assert.equal(resolveLfoCfg({ depth: 0.5 }, { base: 10 }).depth, 5);
	assert.equal(resolveLfoCfg({ depth: 0.5 }, { base: 0 }).depth, 0.5);
	assert.equal(resolveLfoCfg({ depth: 0.5, depthabs: 7 }, { base: 10 }).depth, 7);
}
// modulatedParamValue clamps to meta
{
	const v = modulatedParamValue(40, { min: 0, max: 45 }, [{ cfg: { freq: 1, depth: 20, dcoffset: -0.5, shape: 1, curve: 1, skew: 0.5, phaseoffset: 0 }, t: 0.25 }]);
	assert.equal(v, 45); // 40 + (1-0.5)*20 = 50 -> clamped to 45
}
ok('modulate.js LFO math matches superdough reference + clamping');

// ── 1b. env math (reference: superdough's EnvelopeProcessor: cumulative stage times, warp) ──
{
	// linear curves, a=0.1 d=0.1 s=0.5 r=0.2, susTime=1.0, depth=2
	const cfg = resolveEnvCfg({ attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.2, depthabs: 2 }, { susTime: 1.0 });
	assert.equal(cfg.kind, 'env');
	assert.ok(Math.abs(envValue(cfg, -0.5)) < 1e-12); // before trigger
	assert.ok(Math.abs(envValue(cfg, 0.05) - 1.0) < 1e-9); // mid-attack: 0.05/0.1 * 2 = 1
	assert.ok(Math.abs(envValue(cfg, 0.099) - 1.98) < 1e-9); // attack near peak: 0.99 * 2
	assert.ok(Math.abs(envValue(cfg, 0.2) - 1) < 1e-9); // decay done: sustain 0.5 * 2 = 1
	assert.ok(Math.abs(envValue(cfg, 0.9) - 1) < 1e-9); // sustain holds until susTime
	// release stage uses cumulative time (susTime + r = 1.2): at t=1.1 phase=1.1/1.2
	assert.ok(Math.abs(envValue(cfg, 1.1) - (0.5 * (1 - 1.1 / 1.2) * 2)) < 1e-9);
	assert.ok(Math.abs(envValue(cfg, 1.2) - 0) < 1e-9); // release done
	assert.ok(Math.abs(envValue(cfg, 5) - 0) < 1e-9); // long after: idle at 0
	// relative depth: depth 0.5 on base 100 -> depth value 50
	assert.equal(resolveEnvCfg({ depth: 0.5 }, { base: 100 }).depth, 50);
	assert.equal(resolveEnvCfg({ depth: 0.5 }, { base: 0 }).depth, 0.5); // base 0 counts as 1
	assert.equal(resolveEnvCfg({ depth: 0.5, depthabs: 7 }, { base: 100 }).depth, 7);
	// warped attack (acurve 1): phase 0.5 -> 1-(1-0.5)^9 ≈ 0.998, val ≈ 0.998*depth
	const wc = resolveEnvCfg({ attack: 0.1, acurve: 1, depthabs: 1 }, { susTime: 1 });
	assert.ok(Math.abs(envValue(wc, 0.05) - (1 - Math.pow(0.5, 9))) < 1e-9);
}
ok('modulate.js env math matches superdough envelope-processor + depth rules');

// ── 2. target resolution against the real test bundle ──
const { rack, bundles, files } = await loadRackBundle(bundleUrl);
assert.equal(rack.source.plugin, 'org.faust.aether');
assert.equal(rack.devices[0].plugin, 'studio.opendaw.commons.wet-chorus');

// build an `info` like the worklet's ready message
const info = { source: null, devices: [] };
{
	const d = await describeBundle(files['faust-aether.wclap.tar.gz']);
	info.source = { plugin: 'org.faust.aether', params: d.plugins[0].params };
	for (const [i, key] of ['wet-chorus', 'pearls'].entries()) {
		const dd = await describeBundle(files[key + '.wclap.tar.gz']);
		info.devices.push({ index: i, plugin: dd.plugins[0].id, params: dd.plugins[0].params });
	}
}
{
	const t = resolveRackTarget(rack, info, 'org.faust.aether/detune_cents');
	assert.deepEqual([t.index, t.param], [-1, 'detune_cents']);
	const t2 = resolveRackTarget(rack, info, 'studio.opendaw.commons.wet-chorus/Speed');
	assert.deepEqual([t2.index, t2.param], [0, 'Speed']);
	const t3 = resolveRackTarget(rack, info, '1/Pitch'); // numeric device index
	assert.deepEqual([t3.index, t3.param], [1, 'Pitch']);
	const t4 = resolveRackTarget(rack, info, '-1/detune_cents');
	assert.equal(t4.index, -1);
	const t5 = resolveRackTarget(rack, info, 'source/detune_cents');
	assert.equal(t5.index, -1);
	const t6 = resolveRackTarget(rack, info, 'detune_cents'); // bare name, unique
	assert.equal(t6.index, -1);
	// module form passes the param through (the worklet guards unknown param ids with paramError)
	const tBad = resolveRackTarget(rack, info, 'org.faust.aether/nope');
	assert.deepEqual([tBad.index, tBad.param], [-1, 'nope']);
	assert.equal(resolveRackTarget(rack, info, 'no.such.module/x'), null); // unknown module
	const tBare = resolveRackTarget(rack, info, 'Speed'); // bare name on device 0
	assert.deepEqual([tBare.index, tBare.param], [0, 'Speed']);
}
ok('resolveRackTarget module/index/source/bare-name forms');

// bare-name ambiguity: aether has many params named 'depth' — bare 'depth' resolves to the
// first slot exposing it, with matches > 1 reported
{
	const t = resolveRackTarget(rack, info, 'depth');
	assert.ok(t, 'bare depth resolves');
	assert.ok(t.matches >= 1);
	const targets = listRackTargets(rack, info);
	assert.ok(targets.includes('org.faust.aether/detune_cents'));
	assert.ok(targets.includes('studio.opendaw.pearls/Pitch'));
}
ok('listRackTargets + bare-name matching');

// ── 3. offline render with param events (the offline .rp/.lfo path) ──
const sr = 48000;
const len = Math.round(0.5 * sr);
const base = { ...rack };
base.source = { ...rack.source, length: len, notes: [{ key: 60, velocity: 0.8, frame: 0, frames: len }] };
const render = (r) => renderRack({ rack: r, bundles, input: null, sampleRate: sr, preRoll: 128 });
const rms = (r) => Math.sqrt(r.left.reduce((a, x) => a + x * x, 0) / r.left.length);

const plain = await render(base);
// static per-hap param on the source (aether detune_cents = 40 instead of rack's 12-ish)
const stat = { ...base, source: { ...base.source, params: { ...base.source.params, detune_cents: 40 } } };
const rStat = await render(stat);
assert.notEqual(fingerprint([rStat.left, rStat.right]), fingerprint([plain.left, plain.right]), 'static param changes the render');
// LFO param events on device 0 (wet-chorus Speed swept 0..10 over the note) — the exact event
// shape the offline path emits: frame = preRoll + f, sampled per 128 frames
const events = [];
for (let f = 0; f < len; f += 128) events.push({ frame: 128 + f, type: 'param', id: 'Speed', value: (f / len) * 10 });
const lfo = { ...base, devices: base.devices.map((d, i) => (i === 0 ? { ...d, paramEvents: events } : d)) };
const rLfo = await render(lfo);
assert.notEqual(fingerprint([rLfo.left, rLfo.right]), fingerprint([plain.left, plain.right]), 'lfo paramEvents change the render');
// and the lfo render differs from a render where the same params sit at frame 0 only
const lfoAt0 = { ...base, devices: base.devices.map((d, i) => (i === 0 ? { ...d, params: { ...d.params, Speed: 10 } } : d)) };
const rLfoAt0 = await render(lfoAt0);
assert.notEqual(fingerprint([rLfo.left, rLfo.right]), fingerprint([rLfoAt0.left, rLfoAt0.right]), 'time-varying events differ from a static end value');
assert.ok(rms(plain) > 0.001, 'baseline render is audible');
console.log(`   rms plain=${rms(plain).toFixed(4)} static=${rms(rStat).toFixed(4)} lfo=${rms(rLfo).toFixed(4)}`);
ok('offline renderRack honors paramEvents + static param overrides');

console.log(`\nall ${passed} node tests passed`);
