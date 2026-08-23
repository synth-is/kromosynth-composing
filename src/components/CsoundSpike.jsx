/**
 * DEV-ONLY spike surface for Csound steps 1 & 2 (docs/CSOUND_PLAN.md §7).
 * Reached at `?csound=1`; see src/main.jsx. Not part of the app UI — the real
 * home for this is the environment tabs (step 5), and this file goes away then.
 *
 * It deliberately fetches its own sounds via api.fetchPublicSounds() rather than
 * borrowing App's kit state: that exercises the REAL preview-WAV path (public,
 * CORS-open, immutable) and keeps App.jsx untouched until the tabs land.
 *
 * What it proves:
 *   1. @csound/browser loads under Vite, on OUR AudioContext, with
 *      autoConnect:false, and makes a sine through a gain node we own.
 *   2. Kit sounds fetched over the network can be written into Csound's virtual
 *      filesystem and played back by filename with diskin2.
 */

import React, { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { getEvoRunId } from '../lib/render.js';
import { renderToWavUrl } from '../lib/renderClient.js';
import * as cs from '../lib/csoundEngine.js';
import * as opcodes from '../lib/csoundOpcodes.js';
import { getConcepts, conceptNames } from '../lib/concepts.js';
import { getEnvironment } from '../lib/environments.js';
import CsoundPad from './CsoundPad.jsx';

const env = getEnvironment('csound');

// Header WITHOUT `sr`: the engine passes --sample-rate to match the browser's
// device rate. ksmps 32 divides the 128-frame worklet quantum.
const HEADER = `ksmps = 32
nchnls = 2
0dbfs = 1`;

const SINE_ORC = `${HEADER}

instr 1
  aEnv linen 0.3, 0.02, p3, 0.4
  aSig poscil aEnv, 440
  out aSig, aSig
endin`;

const SINE_SCO = 'i 1 0 2';

/**
 * A play-the-kit-sound orchestra. Mono vs stereo matters: diskin2 needs as many
 * outputs as the file has channels, and our renders are mono — which is exactly
 * why the engine parses WAV headers.
 */
function kitOrc(path, channels) {
  const read = channels === 2
    ? `  aL, aR diskin2 "${path}", p4`
    : `  aL diskin2 "${path}", p4\n  aR = aL`;
  return `${HEADER}

instr 2
  ; p4 = playback rate (1 = as recorded). Reading straight off Csound's
  ; virtual filesystem — no URLs involved once the file is written in.
${read}
  ; 0.2, not 0.8: kit sounds are peak-normalised and these hits OVERLAP, so four
  ; voices at 0.8 summed past 0dbfs in the first run (overall amps 2.08).
  aEnv linen 0.2, 0.005, p3, 0.03
  out aL * aEnv, aR * aEnv
endin`;
}

/** Four hits at rising playback rates — proves p-fields and scheduling, not just "a sound". */
function kitSco(dur) {
  const d = Math.max(0.2, Math.min(dur || 2, 6));
  const step = Math.min(d, 0.6);
  return [1, 1.25, 1.5, 2]
    .map((rate, i) => `i 2 ${(i * step).toFixed(3)} ${d.toFixed(3)} ${rate}`)
    .join('\n');
}

/**
 * Starter and "surprise me" now come from the real environment object (step 4,
 * lib/environments.js) rather than a local copy — so the spike exercises what the
 * tabs will actually use.
 */

/** One opcode with its signature(s) — exactly the line a prompt would receive. */
function OpcodeRow({ name }) {
  const [entry, setEntry] = useState(null);
  useEffect(() => {
    let cancelled = false;
    opcodes.getOpcode(name).then((e) => { if (!cancelled) setEntry(e); }).catch(() => {});
    return () => { cancelled = true; };
  }, [name]);
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <code style={{ minWidth: 150 }}>{name}</code>
      <span className="muted" style={{ fontSize: 11 }}>
        {entry ? opcodes.formatOpcode(entry).slice(name.length + 2) : '…'}
      </span>
    </div>
  );
}

export default function CsoundSpike() {
  const [, force] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [kit, setKit] = useState([]);          // [{ name, url, label }]
  const [ops, setOps] = useState(null);        // { names, totalSignatures, buildMs } | null
  const [opQuery, setOpQuery] = useState('');
  const [opHits, setOpHits] = useState([]);
  const [missQuery, setMissQuery] = useState('arpeggiate');
  const [missHits, setMissHits] = useState([]);
  const [conceptResults, setConceptResults] = useState(null); // [{ id, label, ok, error }]
  const [palette, setPalette] = useState(null); // { missing: string[], picks: [] }
  const padRef = useRef(null);
  const status = cs.getStatus();
  const info = cs.getKitInfo();

  useEffect(() => cs.subscribe(() => force((n) => n + 1)), []);

  const getKitMap = () => Object.fromEntries(kit.map((k) => [k.name, k.url]));

  const run = async (what, fn) => {
    setBusy(what); setError('');
    try { await fn(); }
    catch (e) { setError(e.message || String(e)); console.error('[csound-spike]', e); }
    finally { setBusy(''); }
  };

  const init = () => run('Starting Csound…', () => cs.initCsound());

  const playSine = () => run('Compiling…', () =>
    cs.compileAndStart({ orc: SINE_ORC, sco: SINE_SCO }));

  const stop = () => run('Stopping…', () => cs.stop());

  const loadKit = () => run('Fetching sounds…', async () => {
    const list = await api.fetchPublicSounds({ orderBy: 'recent', limit: 24 });
    if (!list.length) throw new Error('No public sounds came back from the recommend service.');
    const taken = new Set();
    const entry = (s, url) => {
      const name = api.uniqueSampleName(s, taken);
      taken.add(name);
      return { name, url, label: s.label };
    };

    // Most community sounds have no pre-rendered preview (api.resolvePreviewUrl
    // returns null), so fall back to the on-demand render — which also exercises
    // the OTHER kit URL flavour: a same-origin blob:. Both must be fetchable as
    // ArrayBuffers for syncKit to work.
    const withPreview = list.filter((s) => s.previewUrl).slice(0, 3);
    let picked;
    if (withPreview.length) {
      picked = withPreview.map((s) => entry(s, s.previewUrl));
    } else {
      setBusy('No previews — rendering one on demand…');
      const s = list[0];
      const url = await renderToWavUrl(s.id, getEvoRunId(s), {
        duration: s.duration ?? 2, noteDelta: 0, velocity: 1,
      });
      picked = [entry(s, url)];
    }

    setKit(picked);
    setBusy('Writing into Csound’s filesystem…');
    await cs.syncKit(Object.fromEntries(picked.map((k) => [k.name, k.url])));
  });

  const playKit = (entry) => run('Compiling…', async () => {
    // compileAndStart resets Csound, which invalidates the FS bookkeeping — so it
    // re-syncs the kit itself before compiling (from cached bytes). Channel count
    // comes from the sync that Load kit already did.
    await cs.compileAndStart({
      orc: kitOrc(cs.kitFilePath(entry.name), info.get(entry.name)?.channels ?? 1),
      sco: kitSco(info.get(entry.name)?.durationSecs ?? 2),
      kitMap: getKitMap(),
    });
  });

  const insertStarter = () => {
    padRef.current?.setCode(env.makeStarter(kit));
    setError('');
  };

  const surpriseMe = () => {
    padRef.current?.setCode(env.makeRandom(kit));
    setError('');
  };

  // Probes the other half of step 8's AI loop: does a deliberately broken
  // orchestra come back as { ok:false } with usable error text?
  const probeValidate = () => run('Validating…', async () => {
    const good = await padRef.current?.validate?.();
    const bad = await cs.validateOrc(`${HEADER}\n\ninstr 1\n  aSig nosuchopcode 1, 2\n  out aSig, aSig\nendin`);
    setError('');
    console.log('[csound-spike] validate current:', good, '| validate broken:', bad);
    setBusy('');
    alert(`current buffer: ${good?.ok ? 'ok' : `FAILED — ${good?.error}`}\n\n`
      + `deliberately broken: ${bad.ok ? 'reported OK (!) — validate is not catching errors' : `caught — ${bad.error}`}`);
  });

  const buildOpcodeIndex = () => run('Enumerating opcodes…', async () => {
    const idx = await opcodes.getOpcodeIndex();
    setOps({ names: idx.names, totalSignatures: idx.totalSignatures, buildMs: idx.buildMs });
    setOpHits(await opcodes.search(''));
    setMissHits(await opcodes.suggest(missQuery));
  });

  const runOpSearch = (q) => {
    setOpQuery(q);
    opcodes.search(q).then(setOpHits).catch(() => setOpHits([]));
  };

  const runSuggest = (q) => {
    setMissQuery(q);
    opcodes.suggest(q).then(setMissHits).catch(() => setMissHits([]));
  };

  /**
   * Compile every concept example against the bundled build.
   *
   * This is the reason it's safe to write a concept library at all: the opcode
   * signatures come from my reading of the docs, and this says which of them the
   * runtime actually accepts. Re-run after any @csound/browser bump — that is what
   * makes §4 rule 2 ("anchor to the bundled version") enforceable rather than a
   * good intention.
   *
   * Transform concepts have no example of their own, so they get a probe: wrap a
   * real signal in apply() and compile that. Leaving them untested was a hole —
   * they're the ones that rely on Csound's functional call syntax.
   */
  const validateConcepts = () => run('Compiling concept examples…', async () => {
    const list = getConcepts('csound');
    const names = conceptNames(kit);
    const kitMap = getKitMap();
    const source = kit[0]?.name
      ? `aSig diskin2 "${cs.kitFilePath(kit[0].name)}", 1`
      : 'aSig poscil 0.2, 220';
    const results = [];
    setConceptResults([]);
    for (const c of list) {
      let buffer = null;
      let kind = '';
      if (c.example) {
        buffer = c.example(names);
        kind = 'example';
      } else if (c.apply) {
        // Probe: does apply() produce something Csound accepts inline?
        buffer = `${HEADER}\n\ninstr 1\n  ${source}\n  aOut = ${c.apply('aSig')}\n  out aOut, aOut\nendin\n\n<CsScore>\ni 1 0 1`;
        kind = 'transform probe';
      }
      if (!buffer) {
        results.push({ id: c.id, label: c.label, skipped: true, kind: 'nothing to compile' });
      } else {
        const { orc, sco } = cs.splitCsoundCode(buffer);
        const r = await cs.validateOrc(orc, { sco, kitMap });
        results.push({ id: c.id, label: c.label, ok: r.ok, error: r.error, kind, buffer });
      }
      setConceptResults([...results]);
    }
    const failed = results.filter((r) => r.ok === false).length;
    console.log(`[csound-spike] concepts: ${results.length - failed} ok, ${failed} failed`, results);
  });

  /** Load one concept example into the pad and play it — the ear half of the audit. */
  const auditionConcept = (r) => {
    if (!r.buffer) return;
    padRef.current?.setCode(r.buffer);
    padRef.current?.play();
  };

  /**
   * Write out a committable opcode index so the app never builds one at runtime.
   * This button is the only place the second wasm instance is meant to happen.
   */
  const exportIndex = () => run('Exporting the opcode index…', async () => {
    const text = await opcodes.exportIndexModule();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'csoundOpcodeIndex.js';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  /** Which of the hand-written surprise palette this build actually has. */
  const checkPalette = () => run('Checking the palette…', async () => {
    const report = await opcodes.paletteReport();
    const picks = [];
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const p = await opcodes.pickSurprise('', seen);
      if (!p) break;
      seen.push(p.name);
      picks.push(p);
    }
    setPalette({ ...report, picks });
  });

  const log = cs.getLog();

  return (
    <div className="app" style={{ padding: 20, maxWidth: 900, margin: '0 auto', display: 'block' }}>
      <h2 style={{ marginTop: 0 }}>Csound spike <span className="muted small">— steps 1 &amp; 2</span></h2>
      <p className="muted small" style={{ marginTop: -8 }}>
        Dev surface only. Remove the <code>?csound=1</code> from the URL for the normal app.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
        <button className="btn" onClick={init} disabled={!!busy || status.ready}>
          {status.ready ? 'Csound ready ✓' : '1 · Init Csound'}
        </button>
        <button className="btn" onClick={playSine} disabled={!!busy}>▶ Play sine (440 Hz)</button>
        <button className="btn ghost" onClick={stop} disabled={!!busy || !status.started}>■ Stop</button>
        <span style={{ width: 12 }} />
        <button className="btn" onClick={loadKit} disabled={!!busy}>2 · Load kit into Csound&apos;s FS</button>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => cs.clearLog()}>Clear log</button>
      </div>

      <div className="muted small">
        {status.ready ? 'engine: ready' : 'engine: not started'}
        {' · '}context: {status.contextState || '—'} @ {status.sampleRate || '—'} Hz
        {' · '}node: {status.nodeType || '—'}
        {' · '}{status.started ? 'performing' : 'idle'}
        {busy ? ` · ${busy}` : ''}
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

      {kit.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>
            Kit in Csound&apos;s filesystem — click to play it four times at rising rates:
          </div>
          {kit.map((k) => {
            const i = info.get(k.name);
            return (
              <div key={k.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                <button className="btn tiny" onClick={() => playKit(k)} disabled={!!busy}>▶ {k.name}</button>
                <code className="muted small">{cs.kitFilePath(k.name)}</code>
                <span className="muted small">
                  {i ? `${i.channels === 1 ? 'mono' : `${i.channels} ch`} · ${i.sampleRate} Hz · ${i.durationSecs.toFixed(2)} s` : 'not written yet'}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>3 · CsoundPad</strong>
          <span className="muted small">same imperative handle as StrudelPad</span>
          <span className="spacer" />
          <button className="btn tiny" onClick={insertStarter}>Insert starter</button>
          <button className="btn tiny ghost" onClick={surpriseMe}>Surprise me</button>
          <button className="btn tiny ghost" onClick={probeValidate} disabled={!!busy}>Probe validate()</button>
        </div>
        <CsoundPad
          ref={padRef}
          initialCode={env.makeStarter([])}
          getKitMap={getKitMap}
          onEval={(code) => console.log('[csound-spike] onEval — would snapshot the trajectory:', code.length, 'chars')}
          onSelectionChange={(sel) => console.log('[csound-spike] selection:', sel && sel.text.slice(0, 40))}
        />
        <div className="muted small" style={{ marginTop: 4 }}>
          Load the kit first, then Insert starter — it references your own sounds by
          filename. The clock instrument re-books itself, which is what makes it loop;
          delete that line and the bar plays once. <a href={env.docsUrl} target="_blank" rel="noopener noreferrer">{env.label} manual ↗</a>
        </div>
      </div>

      {kit.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>Hints from the environment object — click to copy:</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {env.hints(kit).map((h) => (
              <button
                key={h.label}
                className="hint-chip"
                title={h.code}
                onClick={() => navigator.clipboard?.writeText(h.code)}
              >
                {h.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>4 · Opcode index</strong>
          <span className="muted small">from libcsound() — no AudioContext involved</span>
          <span className="spacer" />
          <button className="btn tiny" onClick={buildOpcodeIndex} disabled={!!busy || !!ops}>
            {ops ? `${ops.names.length} opcodes ✓` : 'Build index'}
          </button>
          <button className="btn tiny ghost" onClick={exportIndex} disabled={!!busy} title="Download csoundOpcodeIndex.js to commit into src/lib/">
            Export index
          </button>
        </div>

        {ops && (
          <>
            <div className="muted small" style={{ marginBottom: 8 }}>
              {ops.names.length} distinct names, {ops.totalSignatures} signatures, built in {ops.buildMs} ms.
              This is the pinned build describing itself — the breadth layer the AI gets.
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px' }}>
                <input
                  className="search"
                  placeholder="Filter opcodes… (try: rev, grain, pvs, diskin)"
                  value={opQuery}
                  onChange={(e) => runOpSearch(e.target.value)}
                />
                <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
                  {opHits.length === 0 && <div className="muted small">No matches.</div>}
                  {opHits.map((n) => (
                    <OpcodeRow key={n} name={n} />
                  ))}
                </div>
              </div>

              <div style={{ flex: '1 1 260px' }}>
                <input
                  className="search"
                  placeholder="Pretend the model invented this opcode…"
                  value={missQuery}
                  onChange={(e) => runSuggest(e.target.value)}
                />
                <div className="muted small" style={{ marginTop: 6 }}>
                  Nearest real opcodes — this is what a repair pass would feed back after
                  “unable to find opcode with name: …”:
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {missHits.map((n) => <span key={n} className="hint-chip">{n}</span>)}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <div style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>5 · Concept examples</strong>
          <span className="muted small">every palette example, compiled against this build</span>
          <span className="spacer" />
          <button className="btn tiny" onClick={validateConcepts} disabled={!!busy}>Validate all concepts</button>
        </div>
        {conceptResults && (
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            {conceptResults.map((r) => (
              <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ width: 16, color: r.skipped ? '#888' : r.ok ? '#6cc06c' : '#e06c6c' }}>
                  {r.skipped ? '–' : r.ok ? '✓' : '✗'}
                </span>
                <button
                  className="btn tiny ghost"
                  style={{ visibility: r.buffer ? 'visible' : 'hidden' }}
                  title="Load into the pad and play — does it sound like the comment says?"
                  onClick={() => auditionConcept(r)}
                >▶</button>
                <span style={{ minWidth: 210 }}>{r.label}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {r.error || r.kind || ''}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="muted small" style={{ marginTop: 6 }}>
          A tick means Csound COMPILED it, not that it sounds like its comments claim.
          Use ▶ to hear each one — that is the half a compiler can’t check.
        </div>
      </div>

      <div style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>6 · Surprise palette</strong>
          <span className="muted small">the wish list, intersected with this build</span>
          <span className="spacer" />
          <button className="btn tiny" onClick={checkPalette} disabled={!!busy}>Check palette</button>
        </div>
        {palette && (
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            <div className="muted small" style={{ marginBottom: 4 }}>
              {palette.usable.length} usable.
            </div>
            {palette.missing.length > 0 && (
              <div className="muted small" style={{ marginBottom: 4 }}>
                Not in this build ({palette.missing.length}) — prune from csoundPalette.js: {palette.missing.join(', ')}
              </div>
            )}
            {palette.tooDeep.length > 0 && (
              <div className="muted small" style={{ marginBottom: 6 }}>
                Too many required arguments for a small model, so never drawn ({palette.tooDeep.length}): {palette.tooDeep.join(', ')}
              </div>
            )}
            <div className="muted small">Sample draws:</div>
            {palette.picks.map((p) => (
              <div key={p.name}><code>{p.name}</code> <span className="muted">— {p.blurb}</span></div>
            ))}
          </div>
        )}
      </div>

      <pre style={{
        marginTop: 18, padding: 12, maxHeight: 380, overflow: 'auto',
        background: 'rgba(0,0,0,.28)', borderRadius: 6, fontSize: 12, lineHeight: 1.45,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {log.length === 0 ? '(no output yet)' : log.map((l, i) => (
          <div key={i} style={{ color: l.kind === 'error' ? '#e06c6c' : l.kind === 'sys' ? '#8ab4f8' : undefined }}>
            {l.kind === 'sys' ? '· ' : l.kind === 'error' ? '✗ ' : '  '}{l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
