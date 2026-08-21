import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import * as cs from '../lib/csoundEngine.js';
import { suggest } from '../lib/csoundOpcodes.js';

/**
 * Csound editor pad — the sibling of StrudelPad, exposing the SAME imperative
 * handle so App.jsx can drive either environment through one ref.
 *
 * Unlike Strudel there is no `<strudel-editor>` web component to wrap, so this
 * builds CodeMirror 6 directly. That's worth the dependency mainly for LINE
 * NUMBERS: Csound reports problems by line ("warning: opcode outs is deprecated,
 * line 8"), so an editor without them makes both learning and the AI repair loop
 * needlessly hard.
 *
 * ── One buffer, orchestra + optional score ──
 * `<CsScore>` (the real .csd section tag — see splitCsoundCode) separates them.
 * No tag means the whole buffer is the orchestra, which is the live-coding case.
 * The engine always appends its own keep-alive f-statement, so the user never has
 * to know that Csound would otherwise stop when the score runs out.
 *
 * ── What's deliberately NOT here ──
 * getPattern / getCps are Strudel's cycle vocabulary and have no Csound meaning;
 * they're absent, and App calls them optionally (`?.`). The Csound bounce is
 * native and expressed in SECONDS — step 7, plus `bounceUnits` on the environment
 * (docs/CSOUND_PLAN.md §6).
 */

// Minimal Csound highlighting. Opcodes aren't listed: once CSOUND_CONCEPTS exists
// (step 6) the concept library can supply that set, so the palette and the
// highlighter stay in sync rather than drifting as two hand-kept lists.
const KEYWORDS = /^(instr|endin|opcode|endop|if|then|ithen|kthen|else|elseif|endif|until|while|do|od|goto|igoto|kgoto|tigoto|rireturn|return|turnoff|turnoff2)\b/;

const csoundLanguage = StreamLanguage.define({
  name: 'csound',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.skipTo('*/')) { stream.match('*/'); state.inBlockComment = false; }
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;

    if (stream.match('/*')) { state.inBlockComment = true; return 'comment'; }
    if (stream.peek() === ';' || stream.match('//')) { stream.skipToEnd(); return 'comment'; }

    // .csd section tags — the orchestra/score split marker
    if (stream.match(/^<\/?Cs[A-Za-z]*>/)) return 'meta';

    if (stream.peek() === '"') {
      stream.next();
      while (!stream.eol()) { if (stream.next() === '"') break; }
      return 'string';
    }
    if (stream.match(/^\d+\.?\d*(e[-+]?\d+)?/i) || stream.match(/^\.\d+/)) return 'number';
    if (stream.match(KEYWORDS)) return 'keyword';
    if (stream.match(/^p\d+\b/)) return 'atom';                 // p-fields
    if (stream.match(/^g?[akixSf][A-Za-z0-9_]*/)) return 'variableName'; // rate-typed vars
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return null;   // opcodes & the rest
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: ';' } },
});

/**
 * Turn "unable to find opcode with name: X" into something actionable.
 *
 * This is the cheap half of grounding. A model asked for Csound reaches for
 * whatever it remembers — mostly 6.x material, and opcodes that never existed — and
 * the bare compiler error tells it only that it was wrong. Handing back the real
 * neighbours from THIS build's opcode list turns the repair pass from a guess into
 * a lookup, and it costs one index build (memoised) instead of stuffing thousands
 * of names into every prompt. See docs/CSOUND_PLAN.md §12.
 */
const UNKNOWN_OPCODE = /unable to find opcode with name:\s*([A-Za-z_][A-Za-z0-9_]*)/i;

async function enrichError(error) {
  if (!error) return error;
  const m = UNKNOWN_OPCODE.exec(error);
  if (!m) return error;
  try {
    const near = await suggest(m[1], 6);
    // No plausible neighbour means the name was invented rather than fumbled.
    // Saying so — and pointing back at the grounded list — beats offering the
    // closest strings in the corpus, which the model would take as permission.
    if (!near.length) {
      return `${error} — "${m[1]}" is not an opcode in this Csound build, and nothing close is. Use an opcode from the techniques listed above rather than inventing one.`;
    }
    return `${error} — "${m[1]}" does not exist in this Csound build. The nearest real opcodes are: ${near.join(', ')}.`;
  } catch {
    return error; // the index is a nicety; never let it break validation
  }
}

const CsoundPad = forwardRef(function CsoundPad(
  { initialCode = '', getKitMap, onEval, onReady, onSelectionChange },
  ref
) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const actionsRef = useRef({});      // keymap handlers read current closures through this
  const [isPlaying, setIsPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState('');

  const getCode = () => viewRef.current?.state.doc.toString() ?? '';

  const doPlay = async () => {
    const code = getCode();
    if (!code.trim()) { setNote('nothing to play'); return; }
    setNote('compiling…');
    try {
      const { orc, sco } = cs.splitCsoundCode(code);
      await cs.compileAndStart({ orc, sco, kitMap: getKitMap?.() || {} });
      setIsPlaying(true);
      setNote('');
      onEval?.(code);
    } catch (e) {
      setIsPlaying(false);
      // Same treatment for a human typo as for the model's — if you reach for an
      // opcode that isn't here, the status line names the ones that are.
      setNote(await enrichError(e.message || String(e)));
      console.error('[CsoundPad] play failed:', e);
    }
  };

  const doStop = async () => {
    try { await cs.stop(); } catch { /* ignore */ }
    setIsPlaying(false);
    setNote('');
  };

  actionsRef.current = { doPlay, doStop };

  useEffect(() => {
    const parent = containerRef.current;
    // Same StrictMode guard as StrudelPad: the second dev mount must not build a
    // second EditorView into the same node.
    if (!parent || viewRef.current) return;

    let lastSel = '';
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialCode,
        extensions: [
          basicSetup,
          oneDark,
          csoundLanguage,
          EditorView.lineWrapping,
          keymap.of([
            { key: 'Mod-Enter', preventDefault: true, run: () => { actionsRef.current.doPlay?.(); return true; } },
            { key: 'Mod-.', preventDefault: true, run: () => { actionsRef.current.doStop?.(); return true; } },
          ]),
          EditorView.theme({
            '&': { minHeight: '320px', fontSize: '14px' },
            '.cm-scroller': { fontFamily: 'monospace', lineHeight: '1.5' },
            '.cm-content': { minHeight: '320px' },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet && !u.docChanged) return;
            const { from, to } = u.state.selection.main;
            const key = `${from}:${to}`;
            if (key === lastSel) return;
            lastSel = key;
            onSelectionChange?.(from === to ? null : { from, to, text: u.state.sliceDoc(from, to) });
          }),
        ],
      }),
    });
    viewRef.current = view;
    setReady(true);
    onReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    getCode,
    setCode: (code) => {
      const view = viewRef.current;
      if (!view) { console.warn('[CsoundPad] setCode: editor not ready'); return; }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code ?? '' } });
    },
    play: doPlay,
    stop: doStop,
    reevaluate: () => { if (isPlaying) doPlay(); },
    isReady: () => !!viewRef.current,
    getSelection: () => {
      const view = viewRef.current;
      if (!view) return null;
      const { from, to } = view.state.selection.main;
      return from === to ? null : { from, to, text: view.state.sliceDoc(from, to) };
    },
    replaceSelection: (text) => {
      const view = viewRef.current;
      if (!view) return null;
      const { from, to } = view.state.selection.main;
      const newTo = from + text.length;
      try {
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: newTo } });
        view.focus();
      } catch (err) { console.error('[CsoundPad] replaceSelection failed:', err); return null; }
      return { from, to: newTo, text };
    },
    // { ok, error } — compiles the orchestra AND parses the score, without
    // starting. Note it stops playback; see validateOrc's header.
    validate: async (code) => {
      const { orc, sco } = cs.splitCsoundCode(code ?? getCode());
      try {
        const r = await cs.validateOrc(orc, { sco, kitMap: getKitMap?.() || {} });
        return r.ok ? r : { ...r, error: await enrichError(r.error) };
      } catch (e) { return { ok: false, error: e.message || String(e) }; }
    },
  }));

  return (
    <div className="pad">
      <div className="pad-toolbar">
        <button className="btn btn-play" onClick={doPlay} disabled={!ready}>▶ Play</button>
        <button className="btn btn-stop" onClick={doStop} disabled={!ready || !isPlaying}>■ Stop</button>
        <span className="pad-status">
          {!ready ? 'loading editor…' : note || (isPlaying ? 'playing' : 'ready')}
        </span>
        <span className="spacer" />
        <span className="muted small">⌘/Ctrl+↵ play · ⌘/Ctrl+. stop</span>
      </div>
      <div ref={containerRef} className="pad-editor" />
    </div>
  );
});

export default CsoundPad;
