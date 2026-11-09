// rack-worklet.js — realtime wclap-rack host inside an AudioWorklet (loaded as a module worklet:
// ctx.audioWorklet.addModule('rack-worklet.js', { type: 'module' })).
//
// One WclapHost per bundle; one plugin per device; devices run serially in process() in rack order.
// The page sends `bundles` as { key: module.wasm bytes } — decompression happens page-side (worklets
// have no DecompressionStream/import()).
// Realtime semantics per SPEC.md §3: no frames are dropped; the summed latency is reported to the
// page (a DAW host would compensate it upward).
import { WclapHost } from './vendor/wclap-rack/index.mjs';

const B = 128; // RenderQuantum

class RackProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.hosts = new Map();
		this.devices = [];
		this.ready = false;
		this.meterEvery = 0; // level-meter posting interval, 0 = off (see {type:'meter'})
		this.meterCount = 0;
		this.port.onmessage = (e) => { void this.onmsg(e.data); };
	}

	async onmsg(m) {
		if (m.type === 'load') {
		 try {
			const { rack, bundles } = m;
			if (rack.source) {
				// the source instrument: rendered from notes, no audio input; feeds the chain
				const s = rack.source;
				const host = await this.hostFor(s.bundle, bundles);
				const plugin = host.createPlugin(s.plugin);
				plugin.activate({ sampleRate, blockSize: B });
				if (s.state) plugin.loadState(Uint8Array.from(atob(s.state), (c) => c.charCodeAt(0)));
				const events = Object.entries(s.params ?? {}).map(([k, v]) => ({
					frame: 0, type: 'param', id: plugin.param(isNaN(Number(k)) ? k : Number(k))?.id ?? k, value: v,
				}));
				this.source = { plugin, events, first: true, pending: [], params: plugin.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, def: p.def, stepped: p.stepped })) };
			}
			for (const [i, d] of rack.devices.entries()) {
				if (d.on === false) { this.devices.push({ index: i, on: false }); continue; }
				let host = this.hosts.get(d.bundle);
				if (!host) {
					// the page sends module.wasm bytes per bundle key (it can gunzip; worklets cannot import())
					host = await WclapHost.load(new Uint8Array(bundles[d.bundle]));
					host.snapshot();
					this.hosts.set(d.bundle, host);
				}
				// no restore() here: realtime keeps all devices alive at once, and restore()
				// would invalidate earlier plugins sharing this host (null function table entries)
				const plugin = host.createPlugin(d.plugin);
				plugin.activate({ sampleRate, blockSize: B });
				if (d.state) plugin.loadState(Uint8Array.from(atob(d.state), (c) => c.charCodeAt(0)));
				const events = Object.entries(d.params ?? {}).map(([k, v]) => ({
					frame: 0, type: 'param', id: plugin.param(isNaN(Number(k)) ? k : Number(k))?.id ?? k, value: v,
				}));
				this.devices.push({
					index: i, on: true, plugin, events, first: true, pending: null,
					latency: 0,
				});
			}
			let latency = this.source ? this.source.plugin.latency() : 0;
			for (const d of this.devices) if (d.on) { d.latency = d.plugin.latency(); latency += d.latency; }
			this.port.postMessage({
				type: 'ready',
				latency,
				source: this.source ? { plugin: rack.source.plugin, params: this.source.params } : null,
				devices: this.devices.map((d) => d.on
					? { index: d.index, plugin: rack.devices[d.index].plugin, params: d.plugin.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, def: p.def, stepped: p.stepped })) }
					: { index: d.index, bypassed: true, plugin: rack.devices[d.index].plugin }),
			});
			this.ready = true;
		 } catch (e) {
			this.port.postMessage({ type: 'error', message: String(e && e.stack || e) });
		 }
		}
		if (m.type === 'note' && this.source) {
			this.source.pending.push({ frame: 0, type: m.on ? 'noteOn' : 'noteOff', key: m.key, velocity: m.on ? (m.velocity ?? 0.8) : 0, channel: 0, noteId: 1 });
			// echo for viz (pianoroll ground truth: what the source is actually sounding)
			this.port.postMessage({ type: 'note', on: m.on, key: m.key, velocity: m.velocity ?? 0.8 });
		}
		if (m.type === 'param') {
			if (m.index === -1 && this.source) {
				this.source.pending.push({ frame: 0, type: 'param', id: m.id, value: m.value });
			} else {
				const d = this.devices[m.index];
				if (d?.on) d.pending = [...(d.pending ?? []), { frame: 0, type: 'param', id: m.id, value: m.value }];
			}
		}
		if (m.type === 'setOn') {
			const d = this.devices[m.index];
			if (d) d.on = m.on;
		}
		// level metering for viz panels: {type:'meter', on, every} — posts {type:'levels'} every
		// `every` render blocks. Off by default; the page turns it on only while a viz is visible.
		if (m.type === 'meter') {
			this.meterEvery = m.on ? (m.every || 16) : 0;
			this.meterCount = 0;
		}
	}

	process(inputs, outputs) {
		try {
			return this._process(inputs, outputs);
		} catch (e) {
			if (!this._errPosted) { this._errPosted = true; this.port.postMessage({ type: 'error', message: 'process: ' + String(e && e.stack || e).slice(0, 500) }); }
			return false;
		}
	}

	async hostFor(key, bundles) {
		let host = this.hosts.get(key);
		if (!host) {
			// the page sends module.wasm bytes per bundle key (it can gunzip; worklets cannot import())
			host = await WclapHost.load(new Uint8Array(bundles[key]));
			host.snapshot();
			this.hosts.set(key, host);
		}
		return host;
	}

	_process(inputs, outputs) {
		const input = inputs[0], output = outputs[0];
		if (!this.ready) return true;
		// meter scratch, allocated once per block: per-device peak/rms accumulated over the interval
		const meter = this.meterEvery > 0;
		const levels = meter ? this.devices.map(() => ({ peak: 0, sum: 0, n: 0 })) : null;
		const srcLevels = meter ? { peak: 0, sum: 0, n: 0 } : null;
		const acc = (accObj, buf) => {
			let peak = accObj.peak, sum = accObj.sum;
			for (let i = 0; i < buf.length; i++) {
				const a = buf[i] < 0 ? -buf[i] : buf[i];
				if (a > peak) peak = a;
				sum += a * a;
			}
			accObj.peak = peak; accObj.sum = sum; accObj.n += buf.length;
		};
		let l, r;
		if (this.source) {
			// source instrument renders from notes (no audio input); its output feeds the chain
			const s = this.source;
			const events = s.first ? [...s.events, ...s.pending] : s.pending;
			s.first = false;
			s.pending = [];
			const out = s.plugin.render(B, events);
			l = out[0];
			r = out[1] ?? out[0];
			if (srcLevels) { acc(srcLevels, l); if (r !== l) acc(srcLevels, r); }
		} else {
			if (!input || input.length === 0) return true;
			l = input[0];
			r = input[1] ?? input[0];
		}
		for (const d of this.devices) {
			if (!d.on) continue;
			const events = d.first ? d.events : (d.pending ?? []);
			d.first = false;
			d.pending = null;
			const out = d.plugin.render(B, events, { input: [l, r] });
			l = out[0];
			r = out[1] ?? out[0];
			if (levels) { const a = levels[d.index]; if (a) { acc(a, l); if (r !== l) acc(a, r); } }
			if (events === d.events) { // first block: params applied now, latency may have changed
				const lat = d.plugin.latency();
				if (lat !== d.latency) {
					d.latency = lat;
					this.port.postMessage({ type: 'latencyUpdate', index: d.index, latency: lat });
				}
			}
		}
		if (meter && ++this.meterCount >= this.meterEvery) {
			this.meterCount = 0;
			const rms = (a) => (a.n > 0 ? Math.sqrt(a.sum / a.n) : 0);
			this.port.postMessage({
				type: 'levels',
				source: srcLevels ? { peak: srcLevels.peak, rms: rms(srcLevels) } : null,
				devices: this.devices.map((d, i) => {
					const a = levels[i];
					return { index: d.index, on: !!d.on, peak: a ? a.peak : 0, rms: a ? rms(a) : 0 };
				}),
			});
			if (levels) for (const a of levels) { a.peak = 0; a.sum = 0; a.n = 0; }
			if (srcLevels) { srcLevels.peak = 0; srcLevels.sum = 0; srcLevels.n = 0; }
		}
		output[0].set(l);
		if (output[1]) output[1].set(r);
		return true;
	}
}

registerProcessor('wclap-rack', RackProcessor);
