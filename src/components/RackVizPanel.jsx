// SPDX-License-Identifier: AGPL-3.0-or-later
// RackVizPanel — a viz/control strip for wclap-rack patterns in the Strudel pad:
//   · waveform of the RAW rack output (analyser fan-out on the shared worklet node)
//   · pianoroll of the notes scheduled to the rack (pattern.queryArc, event-level)
//   · per-device strip from the worklet's `ready` message: level bars (meter messages),
//     bypass toggles and parameter sliders, all posted back over the node port
// Drives itself with its own rAF — independent of re-evals, works for any pattern
// using s("wclap-rack") without tagging it with a viz method.
import React, { useEffect, useRef, useState } from 'react';
import { getRackAnalyser, getRackInfo, onRackEvent, setRackMeter, setRackParam, setRackDeviceOn } from '@kromosynth/strudel-rack';

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
  const [spec, setSpec] = useState(null);       // active rack URL
  const [info, setInfo] = useState(null);       // worklet `ready` message
  const [levels, setLevels] = useState(null);   // latest `levels` message
  const [notes, setNotes] = useState([]);       // echoed note on/off events (sounding now)
  const specRef = useRef(null);
  const levelsRef = useRef(null);
  const notesRef = useRef([]);

  // find the rack the current pattern is playing, and subscribe to its worklet
  useEffect(() => {
    let unsub = null;
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
        specRef.current = found;
        setSpec(found);
        setInfo(found ? getRackInfo(found) : null);
        setLevels(null);
        notesRef.current = [];
        setNotes([]);
        if (found) {
          unsub = onRackEvent(found, (m) => {
            if (m.type === 'ready') setInfo(m);
            else if (m.type === 'levels') { levelsRef.current = m; setLevels(m); }
            else if (m.type === 'note') {
              const cur = notesRef.current.filter((n) => n.key !== m.key);
              if (m.on) cur.push({ key: m.key, velocity: m.velocity });
              notesRef.current = cur;
              setNotes(cur);
            }
          });
          setRackMeter(found, true, 16);
        }
      }
    }, 500);
    return () => { clearInterval(poll); unsub?.(); if (specRef.current) setRackMeter(specRef.current, false); };
  }, [strudelRef]);

  // rAF: waveform + pianoroll
  useEffect(() => {
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
          // sounding-now keys (worklet echo) as bright rows
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
          // playhead
          ctx.fillStyle = '#ffcc00';
          ctx.fillRect(xOf(t), rollY, Math.max(1, dpr), rollH);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [strudelRef, spec]);

  const devices = info?.devices ?? [];
  const source = info?.source ?? null;

  return (
    <div className="pad" style={{ marginTop: 8 }}>
      <div className="pad-toolbar">
        <span className="pad-status">rack viz{ spec ? ` · ${spec.split('/').pop()}` : '' }</span>
      </div>
      <canvas ref={canvasRef} style={{ width: '100%', height: 140, display: 'block', borderRadius: 6 }} />
      {(devices.length > 0 || source) && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {source && (
            <DeviceRow
              key="src"
              name={`${source.plugin} (source)`}
              params={source.params}
              level={levels?.source}
              onParam={(id, v) => setRackParam(spec, -1, id, v)}
            />
          )}
          {devices.map((d) => (
            <DeviceRow
              key={d.index}
              name={d.plugin ?? `device ${d.index}`}
              bypassed={d.bypassed || (levels && !levels.devices.find((x) => x.index === d.index)?.on)}
              params={d.params}
              level={levels?.devices?.find((x) => x.index === d.index)}
              onParam={(id, v) => setRackParam(spec, d.index, id, v)}
              onToggle={(on) => setRackDeviceOn(spec, d.index, on)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceRow({ name, params = [], level, bypassed, onParam, onToggle }) {
  const [vals, setVals] = useState({});
  const lvl = level ? Math.max(level.peak, level.rms * 2) : 0;
  return (
    <div style={{ border: '1px solid #2a2f3a', borderRadius: 6, padding: '4px 8px', opacity: bypassed ? 0.45 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: '1 1 auto', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ flex: '0 0 80px', height: 6, background: '#1c2027', borderRadius: 3, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.min(100, lvl * 100)}%`, background: '#75baff' }} />
        </span>
        {onToggle && (
          <button className="mini" style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => onToggle(bypassed)}>
            {bypassed ? 'off' : 'on'}
          </button>
        )}
      </div>
      {params.map((p) => {
        const v = vals[p.id] ?? p.def ?? p.min ?? 0;
        return (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginTop: 2 }}>
            <span style={{ flex: '0 0 30%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#9aa4b2' }} title={p.name}>{p.name}</span>
            <input
              type="range"
              style={{ flex: '1 1 auto', minWidth: 40 }}
              min={p.min ?? 0}
              max={p.max ?? 1}
              step={p.stepped ? Math.max(1e-9, ((p.max ?? 1) - (p.min ?? 0)) / 100) : Math.max(1e-9, ((p.max ?? 1) - (p.min ?? 0)) / 1000)}
              value={v}
              onChange={(e) => { const nv = parseFloat(e.target.value); setVals((s) => ({ ...s, [p.id]: nv })); onParam?.(p.id, nv); }}
            />
            <span style={{ flex: '0 0 48px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#9aa4b2' }}>{Number(v).toPrecision(3)}</span>
          </div>
        );
      })}
    </div>
  );
}
