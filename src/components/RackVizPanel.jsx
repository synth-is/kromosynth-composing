// SPDX-License-Identifier: AGPL-3.0-or-later
// RackVizPanel — a viz/control strip for wclap-rack patterns in the Strudel pad:
//   · waveform of the RAW rack output (analyser fan-out on the shared worklet node)
//   · pianoroll of the notes scheduled to the rack (pattern.queryArc, event-level)
//   · per-device strip from the worklet's `ready` message: level bars (meter messages),
//     bypass toggles, parameter sliders (param messages) and a "view" button per device that
//     opens the plugin's OWN editor page (the bundle's index.html served by /wclap-sw.js in an
//     iframe, frames relayed over clap.webview) — the same native view the Synth.is plugin shows
// The whole panel collapses to its toolbar line (handy with several racks on screen).
import React, { useEffect, useRef, useState } from 'react';
import {
  getRackAnalyser, getRackInfo, getRack, onRackEvent, setRackMeter, setRackParam, setRackDeviceOn,
  openRackDeviceGui, sendRackGuiFrame, closeRackDeviceGui, handleRackGuiMessage, serveRackBundleUi,
} from '@kromosynth/strudel-rack';

const LOOKBEHIND = 1;   // cycles
const LOOKAHEAD = 3;    // cycles

function noteToMidi(v) {
  // mirror @strudel/core's valueToMidi for plain note values; numeric midi passes through
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  if (globalThis.noteToMidi) { try { return globalThis.noteToMidi(v); } catch { /* fall through */ } }
  const m = /^([a-gA-G])([#b]?)(-?\d+)$/.exec(v.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  return base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
}

export default function RackVizPanel({ strudelRef }) {
  const canvasRef = useRef(null);
  const iframeRef = useRef(null);
  const [spec, setSpec] = useState(null);       // active rack URL
  const [info, setInfo] = useState(null);       // worklet `ready` message
  const [levels, setLevels] = useState(null);   // latest `levels` message
  const [paramVals, setParamVals] = useState({}); // live param values from the worklet: { [index]: { [pid]: { value, mods } } }
  const [notes, setNotes] = useState([]);       // echoed note on/off events (sounding now)
  const [collapsed, setCollapsed] = useState(false);
  const [gui, setGui] = useState(null);         // { index, url } when a device's native view is open
  const specRef = useRef(null);
  const guiRef = useRef(null);
  const levelsRef = useRef(null);
  const notesRef = useRef([]);
  const paramValsRef = useRef({});

  // find the rack the current pattern is playing, and subscribe to its worklet. The node is
  // created asynchronously (fetch + wasm compile), so the subscription is (re)made whenever the
  // `ready` info appears or changes — onRackEvent no-ops while the node does not exist yet.
  const infoRef = useRef(null);
  useEffect(() => {
    let unsub = null;
    let subscribed = null; // { spec, info }
    const handler = (found) => (m) => {
      handleRackGuiMessage(found, m);
      if (m.type === 'ready') { infoRef.current = m; setInfo(m); }
      else if (m.type === 'levels') { levelsRef.current = m; setLevels(m); }
      else if (m.type === 'paramValue' || m.type === 'paramValues') {
        // live param values from the worklet — sliders track .rp()/.lfo()/.env() changes
        // from the code (and echo slider drags back, clamped)
        const entries = m.type === 'paramValues' ? m.values : [m];
        const next = { ...paramValsRef.current };
        for (const e of entries) {
          if (e.index == null || e.id == null || !Number.isFinite(e.value)) continue;
          const slot = { ...(next[String(e.index)] ?? {}) };
          slot[e.id] = { value: e.value, mods: e.mods ?? 0 };
          next[String(e.index)] = slot;
        }
        paramValsRef.current = next;
        setParamVals(next);
      }
      else if (m.type === 'note') {
        const cur = notesRef.current.filter((n) => n.key !== m.key);
        if (m.on) cur.push({ key: m.key, velocity: m.velocity });
        notesRef.current = cur;
        setNotes(cur);
      } else if (m.type === 'gui') {
        if (m.ok) {
          (async () => {
            const rack = getRack(found);
            const bundleKey = m.index === -1 ? rack?.source?.bundle : rack?.devices?.[m.index]?.bundle;
            const base = bundleKey ? await serveRackBundleUi(found, bundleKey) : null;
            if (base) {
              const g = { index: m.index, url: `${base}${m.uri?.startsWith('/') ? m.uri : '/' + (m.uri ?? 'index.html')}` };
              guiRef.current = g;
              setGui(g);
              // the view renders inline under the clicked device line — bring it into view
              setTimeout(() => iframeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
            }
          })();
        }
      } else if (m.type === 'guiFrame') {
        const cw = iframeRef.current?.contentWindow;
        if (cw && guiRef.current && m.index === guiRef.current.index) cw.postMessage(m.data, '*');
      } else if (m.type === 'guiClosed') {
        guiRef.current = null;
        setGui(null);
      }
    };
    const poll = setInterval(() => {
      const repl = strudelRef.current?.getRepl?.();
      const pattern = repl?.scheduler?.pattern;
      if (!pattern) return;
      const t = repl.scheduler.now();
      let found = null;
      try {
        for (const h of pattern.queryArc(t - 0.001, t + 0.001)) {
          if (h.value?.s === 'wclap-rack' && typeof h.value?.rack === 'string') { found = h.value.rack; break; }
        }
      } catch { /* pattern mid-eval */ }
      if (found !== specRef.current) {
        if (specRef.current) setRackMeter(specRef.current, false);
        unsub?.();
        subscribed = null;
        specRef.current = found;
        setSpec(found);
        setLevels(null);
        paramValsRef.current = {};
        setParamVals({});
        notesRef.current = [];
        setNotes([]);
        if (guiRef.current && found) { closeRackDeviceGui(found, guiRef.current.index); }
        guiRef.current = null;
        setGui(null);
      }
      if (!found) return;
      const inf = getRackInfo(found);
      if (inf && (!subscribed || subscribed.spec !== found || subscribed.info !== inf)) {
        // node (re)created: subscribe and adopt its ready info
        unsub?.();
        subscribed = { spec: found, info: inf };
        infoRef.current = inf;
        setInfo(inf);
        unsub = onRackEvent(found, handler(found));
        setRackMeter(found, true, 16);
      }
    }, 500);
    return () => { clearInterval(poll); unsub?.(); if (specRef.current) setRackMeter(specRef.current, false); };
  }, [strudelRef]);

  // iframe -> worklet: the page inside posts ArrayBuffers via window.parent.postMessage
  useEffect(() => {
    const onMsg = (e) => {
      const g = guiRef.current;
      if (!g || !iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (e.data instanceof ArrayBuffer && specRef.current) sendRackGuiFrame(specRef.current, g.index, e.data);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const openNative = async (index) => {
    if (!spec) return;
    if (guiRef.current && guiRef.current.index === index) { closeRackDeviceGui(spec, index); return; }
    const r = await openRackDeviceGui(spec, index); // 'gui' message sets gui state via the subscription
    if (!r?.ok) console.warn('[rack-viz] device gui open failed:', r?.detail);
  };

  // rAF: waveform + pianoroll
  useEffect(() => {
    if (collapsed) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#101216';
      ctx.fillRect(0, 0, w, h);

      const repl = strudelRef.current?.getRepl?.();
      const pattern = repl?.scheduler?.pattern;
      const t = repl?.scheduler?.now() ?? 0;

      // waveform of the raw rack output (top half)
      const an = spec ? getRackAnalyser(spec) : null;
      const waveH = Math.floor(h * 0.42);
      if (an) {
        const buf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(buf);
        ctx.strokeStyle = '#75baff';
        ctx.lineWidth = Math.max(1, dpr);
        ctx.beginPath();
        for (let i = 0; i < buf.length; i++) {
          const x = (i / (buf.length - 1)) * w;
          const y = waveH / 2 - buf[i] * (waveH / 2) * 0.9;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = '#5a6472';
        ctx.font = `${11 * dpr}px sans-serif`;
        ctx.fillText('no wclap-rack pattern playing — use note("c3 e3 g3").s("wclap-rack").rack(url)', 8 * dpr, waveH / 2);
      }

      // pianoroll of notes scheduled to the rack (bottom half)
      const rollY = waveH + 6 * dpr, rollH = h - rollY - 4 * dpr;
      if (pattern && spec) {
        let haps = [];
        try {
          haps = pattern.queryArc(t - LOOKBEHIND, t + LOOKAHEAD).filter((hh) => hh.value?.s === 'wclap-rack' && hh.value?.rack === spec);
        } catch { /* mid-eval */ }
        const midis = haps.map((hh) => noteToMidi(hh.value.note ?? hh.value.n)).filter((m) => m != null);
        const sounding = notesRef.current.map((n) => n.key);
        if (midis.length) {
          const lo = Math.min(...midis, ...sounding) - 1;
          const hi = Math.max(...midis, ...sounding) + 1;
          const yOf = (m) => rollY + rollH - ((m - lo) / (hi - lo)) * rollH;
          const xOf = (c) => ((c - (t - LOOKBEHIND)) / (LOOKAHEAD + LOOKBEHIND)) * w;
          for (const n of notesRef.current) {
            ctx.fillStyle = 'rgba(255, 204, 0, 0.25)';
            ctx.fillRect(0, yOf(n.key) - 1, w, Math.max(2, rollH / (hi - lo)) - 2);
          }
          for (const hh of haps) {
            const m = noteToMidi(hh.value.note ?? hh.value.n);
            if (m == null) continue;
            const x0 = xOf(hh.whole.begin.valueOf());
            const x1 = xOf(hh.whole.end.valueOf());
            const vel = hh.value.velocity ?? hh.value.gain ?? 1;
            ctx.fillStyle = `rgba(117, 186, 255, ${Math.min(1, 0.25 + 0.6 * vel)})`;
            ctx.fillRect(x0, yOf(m), Math.max(1, x1 - x0), Math.max(2, rollH / (hi - lo)) - 2);
          }
          ctx.fillStyle = '#ffcc00';
          ctx.fillRect(xOf(t), rollY, Math.max(1, dpr), rollH);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [strudelRef, spec, collapsed]);

  const devices = info?.devices ?? [];
  const source = info?.source ?? null;

  return (
    <div className="pad" style={{ marginTop: 8 }}>
      <div className="pad-toolbar">
        <button className="mini" style={{ fontSize: 10, cursor: 'pointer', marginRight: 8 }} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="pad-status">rack viz{ spec ? ` · ${spec.split('/').pop()}` : '' }</span>
      </div>
      {!collapsed && (
        <>
          <canvas ref={canvasRef} style={{ width: '100%', height: 140, display: 'block', borderRadius: 6 }} />
          {(devices.length > 0 || source) && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {source && (
                <React.Fragment key="src">
                  <DeviceRow
                    name={`${source.plugin} (source)`}
                    pluginId={source.plugin}
                    params={source.params}
                    liveVals={paramVals['-1']}
                    level={levels?.source}
                    onParam={(id, v) => setRackParam(spec, -1, id, v)}
                    onView={() => openNative(-1)}
                    viewOpen={gui?.index === -1}
                  />
                  {gui?.index === -1 && <NativeView index={-1} url={gui.url} onClose={() => spec && closeRackDeviceGui(spec, -1)} iframeRef={iframeRef} />}
                </React.Fragment>
              )}
              {devices.map((d) => (
                <React.Fragment key={d.index}>
                  <DeviceRow
                    name={d.plugin ?? `device ${d.index}`}
                    pluginId={d.plugin ?? String(d.index)}
                    bypassed={d.bypassed || (levels && !levels.devices.find((x) => x.index === d.index)?.on)}
                    params={d.params}
                    liveVals={paramVals[String(d.index)]}
                    level={levels?.devices?.find((x) => x.index === d.index)}
                    onParam={(id, v) => setRackParam(spec, d.index, id, v)}
                    onToggle={(on) => setRackDeviceOn(spec, d.index, on)}
                    onView={() => openNative(d.index)}
                    viewOpen={gui?.index === d.index}
                  />
                  {gui?.index === d.index && <NativeView index={d.index} url={gui.url} onClose={() => spec && closeRackDeviceGui(spec, d.index)} iframeRef={iframeRef} />}
                </React.Fragment>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DeviceRow({ name, pluginId, params = [], liveVals, level, bypassed, onParam, onToggle, onView, viewOpen }) {
  const [vals, setVals] = useState({});       // local drag values (win while dragging)
  const [open, setOpen] = useState(false); // parameter sliders collapsed by default
  const [copied, setCopied] = useState(null); // param name whose Strudel target was just copied
  const [dragging, setDragging] = useState(false); // while true, the slider shows the drag value, not the live one
  const lvl = level ? Math.max(level.peak, level.rms * 2) : 0;
  // click a param name to copy its Strudel target, e.g. .rp('org.faust.aether/detune_cents', …)
  const copyTarget = (p) => {
    const target = `${pluginId}/${p.name}`;
    try { navigator.clipboard?.writeText(target); } catch { /* clipboard may be unavailable */ }
    setCopied(p.name);
    setTimeout(() => setCopied((c) => (c === p.name ? null : c)), 1200);
  };
  return (
    <div style={{ border: '1px solid #2a2f3a', borderRadius: 6, padding: '4px 8px', opacity: bypassed ? 0.45 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {params.length > 0 && (
          <button className="mini" style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}
            title={open ? 'Hide parameters' : 'Show parameters'} aria-expanded={open}>
            {open ? '▾' : '▸'}
          </button>
        )}
        <span style={{ flex: '1 1 auto', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {params.length > 0 && (
          <span style={{ fontSize: 10, color: '#9aa4b2', cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
            {params.length} params
          </span>
        )}
        <span style={{ flex: '0 0 80px', height: 6, background: '#1c2027', borderRadius: 3, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.min(100, lvl * 100)}%`, background: '#75baff' }} />
        </span>
        {onView && (
          <button className="mini" style={{ fontSize: 10, cursor: 'pointer', borderColor: viewOpen ? '#75baff' : undefined }} onClick={onView}>
            {viewOpen ? 'viewing' : 'view'}
          </button>
        )}
        {onToggle && (
          <button className="mini" style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => onToggle(bypassed)}>
            {bypassed ? 'off' : 'on'}
          </button>
        )}
      </div>
      {open && params.map((p) => {
        // live value from the worklet (code-driven .rp/.lfo/.env and slider echoes) wins over
        // the drag-local value except while the user is actively dragging
        const lv = liveVals?.[p.id];
        const v = dragging ? (vals[p.id] ?? lv?.value ?? p.def ?? p.min ?? 0) : (lv?.value ?? vals[p.id] ?? p.def ?? p.min ?? 0);
        return (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginTop: 2 }}>
            <span
              style={{ flex: '0 0 30%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: copied === p.name ? '#8ab4f8' : '#9aa4b2', cursor: 'copy' }}
              title={`click to copy the Strudel target ${pluginId}/${p.name} — use it as .rp('${pluginId}/${p.name}', …) or .lfo({ c: '${pluginId}/${p.name}', … })`}
              onClick={() => copyTarget(p)}
            >{copied === p.name ? `${pluginId}/${p.name} ✓` : p.name}</span>
            <input
              type="range"
              style={{ flex: '1 1 auto', minWidth: 40 }}
              min={p.min ?? 0}
              max={p.max ?? 1}
              step={p.stepped ? Math.max(1e-9, ((p.max ?? 1) - (p.min ?? 0)) / 100) : Math.max(1e-9, ((p.max ?? 1) - (p.min ?? 0)) / 1000)}
              value={v}
              onPointerDown={() => setDragging(true)}
              onPointerUp={() => setDragging(false)}
              onChange={(e) => { const nv = parseFloat(e.target.value); setVals((s) => ({ ...s, [p.id]: nv })); onParam?.(p.id, nv); }}
            />
            <span
              style={{ flex: '0 0 48px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: lv?.mods > 0 ? '#ffcc00' : '#9aa4b2' }}
              title={lv?.mods > 0 ? `modulated by ${lv.mods} lfo/env from the pattern` : undefined}
            >{Number(v).toPrecision(3)}</span>
          </div>
        );
      })}
    </div>
  );
}

function NativeView({ index, url, onClose, iframeRef }) {
  // "maximise" = a fixed full-window overlay on the SAME wrapper, so the iframe is never remounted
  // (the plugin page and its clap.webview frame relay keep running). Esc restores.
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!max) return;
    const onKey = (e) => { if (e.key === 'Escape') setMax(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [max]);
  const wrap = max
    ? { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column', background: '#111012', border: '1px solid #2a2f3a' }
    : { margin: '2px 0 4px 10px', border: '1px solid #2a2f3a', borderRadius: 6, overflow: 'hidden' };
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px', background: '#171a20' }}>
        <span style={{ flex: '1 1 auto', fontSize: 11, color: '#9aa4b2' }}>
          device {index === -1 ? 'source' : index} native view{max ? ' · Esc to restore' : ''}
        </span>
        <button className="mini" style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => setMax((m) => !m)}
          title={max ? 'Restore size' : 'Maximise to the full window'}>
          {max ? '⤡ restore' : '⤢ maximise'}
        </button>
        <button className="mini" style={{ fontSize: 10, cursor: 'pointer' }} onClick={onClose}>close ×</button>
      </div>
      <iframe
        ref={iframeRef}
        src={url}
        title={`rack device ${index}`}
        style={{ width: '100%', height: max ? undefined : 320, flex: max ? '1 1 auto' : undefined, border: 0, display: 'block', background: '#111012' }}
      />
    </div>
  );
}
