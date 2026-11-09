// rack.mjs — the reference rack renderer for the wclap-rack standard (see SPEC.md).
//
// A rack document (rack.json) is an ordered list of devices; each device references a WCLAP bundle
// by MANIFEST key and a plugin by clap id:
//   { "format": "wclap-rack", "version": 1, "name"?, "devices": [
//       { "bundle": "testfx", "plugin": "is.synth.kromosynth.testfx", "on": true,
//         "params": { "0": -6 }, "state"?: "<base64 clap.state>" } ] }
//
// Render semantics (offline, what renderRack implements):
//   - devices run serially in array order over a stereo stream; "on": false is a bit-transparent bypass;
//   - `preRoll` frames of silence are prepended once, so parameter ramps settle before the audio;
//   - each device's params are applied as param events at frame 0 of its render (in the pre-rolled
//     stream), `state` (when present) is loaded first via clap.state;
//   - each device's reported clap.latency is compensated AT THAT DEVICE (its output is realigned), so
//     the rack output is sample-aligned with the rack input and has the input's length. Realtime hosts
//     should instead report the summed latency upward (CLAP convention) and not drop frames.
//   - one WclapHost per bundle, snapshot() after load, restore() before every device render, so any
//     number of devices and slots can share a bundle deterministically.
//
// Everything here is environment-agnostic: it runs in Node, a browser page and an AudioWorklet.

import { WclapHost, fingerprint } from './host.mjs';
import { loadBundleBytesAsync } from './bundle.mjs';

export const RACK_FORMAT = 'wclap-rack';
export const RACK_VERSION = 1;

/** sha256 hex of bytes, via WebCrypto (Node >= 20 and all browsers have globalThis.crypto.subtle). */
export async function sha256Hex(bytes) {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Structural validation of a rack document (the JSON Schema in schema/ is the normative form). */
export function validateRackDoc(rack) {
	const errors = [];
	if (!rack || typeof rack !== 'object') return ['rack: not an object'];
	if (rack.format !== RACK_FORMAT) errors.push(`rack.format must be "${RACK_FORMAT}"`);
	if (rack.version !== RACK_VERSION) errors.push(`rack.version must be ${RACK_VERSION}`);
	if (!Array.isArray(rack.devices)) errors.push('rack.devices must be an array');
	else rack.devices.forEach((d, i) => {
		if (typeof d.bundle !== 'string' || !d.bundle) errors.push(`devices[${i}].bundle missing`);
		if (typeof d.plugin !== 'string' || !d.plugin) errors.push(`devices[${i}].plugin missing`);
		if (d.on !== undefined && typeof d.on !== 'boolean') errors.push(`devices[${i}].on must be boolean`);
		if (d.params !== undefined && (typeof d.params !== 'object' || d.params === null || Array.isArray(d.params))) errors.push(`devices[${i}].params must be an object`);
		if (d.state !== undefined && typeof d.state !== 'string') errors.push(`devices[${i}].state must be a base64 string`);
	});
	return errors;
}

/**
 * Verify a rack bundle directory: rack.json structure, MANIFEST entries and the sha256 of every
 * referenced module.wasm. `bundles` is { key: archive-or-wasm bytes } (already extracted from the
 * rack bundle). Returns { errors, manifest }.
 */
export async function validateRackBundle(rack, manifest, bundles) {
	const errors = validateRackDoc(rack);
	for (const d of rack.devices ?? []) {
		const entry = manifest?.[d.bundle];
		if (!entry) { errors.push(`device for bundle "${d.bundle}" is not in the MANIFEST`); continue; }
		const bytes = bundles?.[d.bundle];
		if (!bytes) { errors.push(`bundle "${d.bundle}" bytes not provided`); continue; }
		const { wasm } = await loadBundleBytesAsync(bytes);
		const sha = await sha256Hex(wasm);
		if (entry.sha256 && sha !== entry.sha256) errors.push(`bundle "${d.bundle}" sha mismatch: MANIFEST ${entry.sha256}, module.wasm ${sha}`);
	}
	return { errors, manifest };
}

const decodeState = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Render a rack (offline).
 *   rack      parsed rack.json; an optional rack.source (instrument device) is rendered from its
 *             notes first and its output becomes the stream; without a source, `input` is required
 *   bundles   { bundleKey: archive/wasm bytes }
 *   input     { left, right } Float32Arrays of equal length (or an array of channels)
 *   options   { sampleRate = 48000, blockSize = 512, preRoll = 4096 }
 * Returns { left, right, latency, tail, devices: [{ plugin, on, latency }], fingerprint }.
 */
export async function renderRack({ rack, bundles, input, sampleRate = 48000, blockSize = 512, preRoll = 4096 }) {
	const errors = validateRackDoc(rack);
	if (errors.length) throw new Error(`invalid rack: ${errors.join('; ')}`);

	const hosts = new Map(); // bundleKey -> host
	const hostFor = async (key) => {
		if (hosts.has(key)) return hosts.get(key);
		const bytes = bundles[key];
		if (!bytes) throw new Error(`rack: bundle "${key}" bytes not provided`);
		const { wasm } = await loadBundleBytesAsync(bytes);
		const host = await WclapHost.load(wasm);
		host.snapshot();
		hosts.set(key, host);
		return host;
	};

	let len;
	if (rack.source) len = input ? (Array.isArray(input) ? input[0].length : input.left.length) : (rack.source.length ?? sampleRate);
	else if (!input) throw new Error('renderRack: no rack.source and no input audio given');
	else len = Array.isArray(input) ? input[0].length : input.left.length;

	let cur;
	const devices = [];
	let latency = 0, tail = 0;
	if (rack.source) {
		// the source instrument: rendered from notes, no audio input; its output feeds the chain
		const s = rack.source;
		const host = await hostFor(s.bundle);
		host.restore();
		const plugin = host.createPlugin(s.plugin);
		try {
			plugin.activate({ sampleRate, blockSize });
			if (s.state) plugin.loadState(decodeState(s.state));
			const events = [
				...Object.entries(s.params ?? {}).map(([k, v]) => ({
					frame: 0, type: 'param', id: plugin.param(isNaN(Number(k)) ? k : Number(k))?.id ?? k, value: v,
				})),
				...((s.notes ?? [{ key: 60, velocity: 0.8, frame: 0 }]).map((n, i) => [
					{ frame: preRoll + (n.frame ?? 0), type: 'noteOn', key: n.key, velocity: n.velocity ?? 0.8, channel: 0, noteId: i + 1 },
					{ frame: preRoll + (n.frame ?? 0) + (n.frames ?? len), type: 'noteOff', key: n.key, velocity: 0, channel: 0, noteId: i + 1 },
				])).flat(),
			];
			const out = plugin.render(preRoll + len, events); // no input: instrument
			cur = out.length > 1 ? [out[0], out[1]] : [out[0], out[0]];
			latency += plugin.latency();
			tail = Math.max(tail, plugin.tail());
			devices.push({ plugin: s.plugin, on: true, source: true, latency: plugin.latency() });
		} finally {
			plugin.destroy();
		}
	} else {
		const chans = Array.isArray(input) ? input : [input.left, input.right ?? input.left];
		cur = chans.map((c) => { const f = new Float32Array(preRoll + len); f.set(c, preRoll); return f; });
	}

	for (const d of rack.devices) {
		if (d.on === false) { devices.push({ plugin: d.plugin, on: false, latency: 0 }); continue; }
		const host = await hostFor(d.bundle);
		host.restore();
		const plugin = host.createPlugin(d.plugin);
		try {
			plugin.activate({ sampleRate, blockSize });
			if (d.state) plugin.loadState(decodeState(d.state));
			const events = Object.entries(d.params ?? {}).map(([k, v]) => ({
				frame: 0, type: 'param', id: plugin.param(isNaN(Number(k)) ? k : Number(k))?.id ?? k, value: v,
			}));
			const out = plugin.renderEffect({ input: cur, preRoll: 0, events }); // preRoll 0: prepended above; latency dropped per device
			latency += plugin.latency();
			tail = Math.max(tail, plugin.tail());
			cur = out.length > 1 ? out : [out[0], out[0]];
			devices.push({ plugin: d.plugin, on: true, latency: plugin.latency() });
		} finally {
			plugin.destroy();
		}
	}
	const left = cur[0].subarray(preRoll), right = (cur[1] ?? cur[0]).subarray(preRoll);
	return { left, right, latency, tail, devices, fingerprint: fingerprint([left, right]) };
}

/** Describe a bundle's plugins and params (for test hosts and tools). No rendering. */
export async function describeBundle(bytes) {
	const { wasm } = await loadBundleBytesAsync(bytes);
	const host = await WclapHost.load(wasm);
	host.snapshot();
	const plugins = [];
	for (const { id, name, features } of host.plugins) {
		host.restore();
		const plugin = host.createPlugin(id);
		plugins.push({
			id, name, features,
			inputChannels: plugin.inputChannels, outputChannels: plugin.outputChannels,
			params: plugin.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, def: p.def, stepped: p.stepped })),
		});
		plugin.destroy();
	}
	return { plugins };
}
