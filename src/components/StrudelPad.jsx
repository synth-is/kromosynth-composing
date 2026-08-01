import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import '@strudel/repl';

/**
 * Wraps Strudel's <strudel-editor> web component (from @strudel/repl).
 *
 * Sample registration strategy: rather than polluting the user's buffer, we
 * prepend `await samples({...kit})` at *play* time. Strudel caches decoded
 * samples by URL, so re-registering on each play is cheap. The kit map is owned
 * by the parent and read via getKitMap() so it always reflects current state.
 *
 * onEval(code) fires on each Play so the parent can record the trajectory.
 *
 * Imperative handle: { getCode, setCode, play, stop, isReady, getCps }.
 */
const StrudelPad = forwardRef(function StrudelPad({ initialCode = '', getKitMap, onEval, onReady }, ref) {
  const containerRef = useRef(null);
  const elRef = useRef(null);
  const readyRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || elRef.current) return;

    // Seed the Strudel editor's CodeMirror settings BEFORE the component reads them
    // (it calls codemirrorSettings.get() when the <strudel-editor> element is
    // constructed). Write a COMPLETE object: a partial one wipes the shipped defaults
    // — including theme:'strudelTheme' and fontFamily:'monospace' — which is what made
    // the editor render as plain, non-monospace text. Values mirror @strudel/codemirror
    // defaultSettings, with line wrapping + autocomplete turned on.
    try {
      localStorage.setItem('codemirror-settings', JSON.stringify({
        keybindings: 'codemirror',
        isBracketMatchingEnabled: false,
        isBracketClosingEnabled: true,
        isLineNumbersDisplayed: true,
        isActiveLineHighlighted: false,
        isAutoCompletionEnabled: true,
        isPatternHighlightingEnabled: true,
        isFlashEnabled: true,
        isTooltipEnabled: false,
        isLineWrappingEnabled: true,
        isTabIndentationEnabled: false,
        isMultiCursorEnabled: false,
        theme: 'strudelTheme',
        fontFamily: 'monospace',
        fontSize: 16,
      }));
    } catch { /* ignore */ }

    const el = document.createElement('strudel-editor');
    el.setAttribute('code', initialCode || '// Synth.is composing — add sounds, then write a pattern\nsilence');
    // IMPORTANT: the web component renders CodeMirror into a SIBLING element, not
    // inside this one. So this placeholder must not take up space, or it pushes the
    // real editor out of view. Hide it; we size the editor's own container below.
    el.style.display = 'none';
    container.appendChild(el);
    elRef.current = el;

    let cancelled = false;
    const start = performance.now();
    const poll = () => {
      if (cancelled) return;
      if (el.editor && el.editor.repl) {
        readyRef.current = true;
        setReady(true);
        // The editor's CodeMirror lives in el.editor.root (a sibling of the hidden
        // placeholder). Make it visible and fill the pad.
        try {
          const root = el.editor.root;
          if (root) { root.style.display = 'block'; root.style.width = '100%'; root.style.minHeight = '280px'; }
        } catch { /* ignore */ }
        try { el.editor.cm?.refresh(); } catch { /* ignore */ }
        try {
          if (typeof el.editor.enableHighlighting === 'function') el.editor.enableHighlighting(true);
        } catch { /* ignore */ }
        onReady?.();
        return;
      }
      if (performance.now() - start > 15000) {
        console.warn('[StrudelPad] editor did not become ready within 15s');
        return;
      }
      setTimeout(poll, 60);
    };
    poll();

    // No cleanup on purpose: <strudel-editor> is a heavy web component with global
    // Web Audio state; we create it once and let it live for the page's lifetime.
    // The `elRef.current` guard at the top of this effect therefore makes it immune
    // to StrictMode's dev double-mount — the second run is skipped rather than
    // destroying and rebuilding the editor (which left the ref pointing at nothing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doPlay = () => {
    const el = elRef.current;
    const editor = el?.editor;
    if (!editor?.repl) return;
    const kitMap = (getKitMap?.() || {});
    const body = (editor.code || '').trim() || 'silence';
    const parts = [];
    const kitEntries = Object.entries(kitMap);
    if (kitEntries.length) {
      // Single-quote the map: Strudel's transpiler turns DOUBLE-quoted string
      // literals into mini-notation patterns, which mangles sample URLs (the "/"
      // in https:// triggers a mini parse error). Single quotes stay plain strings.
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const lit = '{' + kitEntries.map(([k, v]) => `'${esc(k)}':'${esc(v)}'`).join(',') + '}';
      parts.push(`await samples(${lit})`);
    }
    parts.push(body);
    const full = parts.join('\n');
    try {
      editor.repl.stop();
      editor.repl.evaluate(full);
      editor.repl.start?.();
      setIsPlaying(true);
      onEval?.(editor.code || '');
    } catch (err) {
      console.error('[StrudelPad] evaluate failed:', err);
    }
  };

  const doStop = () => {
    const editor = elRef.current?.editor;
    if (!editor?.repl) return;
    try {
      editor.repl.stop();
      editor.repl.hush?.();
    } catch { /* ignore */ }
    setIsPlaying(false);
  };

  useImperativeHandle(ref, () => ({
    getCode: () => elRef.current?.editor?.code ?? '',
    setCode: (code) => {
      const editor = elRef.current?.editor;
      if (!editor) { console.warn('[StrudelPad] setCode: editor not ready'); return; }
      try { editor.setCode(code); }
      catch (err) { console.error('[StrudelPad] setCode failed:', err); }
    },
    play: doPlay,
    stop: doStop,
    // Re-run the current buffer through the editor (re-registers kit samples), so a
    // freshly re-rendered sound is picked up live without a manual re-Play.
    reevaluate: () => { if (isPlaying) doPlay(); },
    isReady: () => readyRef.current,
    // cycles-per-second from the scheduler, for loop-aligned bounce lengths.
    getCps: () => {
      const repl = elRef.current?.editor?.repl;
      return repl?.scheduler?.cps ?? repl?.cps ?? null;
    },
  }));

  return (
    <div className="pad">
      <div className="pad-toolbar">
        <button className="btn btn-play" onClick={doPlay} disabled={!ready}>▶ Play</button>
        <button className="btn btn-stop" onClick={doStop} disabled={!ready}>■ Stop</button>
        <span className="pad-status">{!ready ? 'loading Strudel…' : isPlaying ? 'playing' : 'ready'}</span>
      </div>
      <div ref={containerRef} className="pad-editor" />
    </div>
  );
});

export default StrudelPad;
