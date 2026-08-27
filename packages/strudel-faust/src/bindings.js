/**
 * bindings.js — how this package reaches a Strudel instance WITHOUT importing one.
 *
 * READ THIS BEFORE ADDING AN IMPORT OF '@strudel/webaudio' HERE. There is more
 * than one live Strudel instance in a page that embeds `<strudel-editor>`, and
 * which one you register a sound into decides whether it can be heard, bounced,
 * or neither.
 *
 *   THE EDITOR'S INSTANCE.  @strudel/repl's own vite.config.js has its
 *   `external` list commented out, so dist/index.mjs INLINES core, webaudio and
 *   superdough (2.29 MB in the installed 1.3.0). `resolve.dedupe` cannot unify
 *   code already baked into a dependency's dist — kromosynth-composing learned
 *   this the expensive way; see docs/ABLETON_BRIDGE.md, where a MediaRecorder
 *   tap on superdough's master recorded silence for exactly this reason.
 *
 *   THE APP'S INSTANCE.  Whatever the host app gets from its own
 *   `import ... from '@strudel/webaudio'`. src/lib/offlineRender.js renders the
 *   Ableton bounce on this one.
 *
 * A sound registered in one is invisible to the other, precisely like kit
 * samples — which is why renderPatternOffline re-registers the kit before it
 * renders. Faust instruments have to be registered twice for the same reason.
 *
 * The way into the editor's instance is `globalThis`: prebake calls
 * `evalScope(..., import('@strudel/webaudio'), ...)`, and evalScope assigns
 * every export of every module onto globalThis (@strudel/core evaluate.mjs).
 * @strudel/webaudio ends with `export * from 'superdough'`, so after prebake
 * `globalThis.registerSound` IS the editor's registry. Before prebake resolves
 * it is undefined, hence the explicit error rather than a silent no-op.
 */

// Needed to register and trigger sounds.
const REQUIRED = ['registerSound', 'getAudioContext', 'getFrequencyFromValue'];
// Needed only to install .fp — a pattern method has to live on the same
// Pattern class the editor's evaluated code will produce.
const PATTERN_DEPS = ['Pattern', 'reify'];

function pick(names, injected) {
  const out = {};
  const missing = [];
  for (const name of names) {
    const found = injected[name] ?? globalThis[name];
    if (found) out[name] = found;
    else missing.push(name);
  }
  return { out, missing };
}

/**
 * Resolve what this package needs from a Strudel instance.
 *
 * @param {object} [injected] any subset of { registerSound, getAudioContext,
 *   getFrequencyFromValue, logger, Pattern, reify }; anything missing falls
 *   back to globalThis (the editor's instance, after prebake). Pass the app's
 *   own imports explicitly to target the app's instance instead.
 */
export function resolveBindings(injected = {}) {
  const { out, missing } = pick(REQUIRED, injected);
  if (missing.length) {
    throw new Error(
      `[strudel-faust] no Strudel instance: ${missing.join(', ')} not found. ` +
      'Either pass them in (deps: { registerSound, getAudioContext, ... }) or ' +
      'call this after the editor\'s prebake has resolved — before that, ' +
      'globalThis carries none of them.',
    );
  }
  // A convenience, not a requirement: fall back to console rather than
  // refusing to register a sound over a missing warning channel.
  out.logger = injected.logger ?? globalThis.logger
    ?? ((msg, kind) => console[kind === 'error' ? 'error' : 'warn'](msg));

  const pattern = pick(PATTERN_DEPS, injected);
  if (!pattern.missing.length) Object.assign(out, pattern.out);
  return out;
}

/** True once the editor's prebake has populated globalThis. */
export function strudelScopeReady() {
  return typeof globalThis.registerSound === 'function';
}

/**
 * Resolve when the editor's Strudel scope is usable.
 *
 * Polls, because prebake exposes no completion event: `<strudel-editor>` hands
 * `prebake` to StrudelMirror and the promise is internal to it. StrudelPad.jsx
 * already polls for `el.editor.repl` for the same reason.
 */
export function whenStrudelScopeReady({ timeoutMs = 20000, intervalMs = 60 } = {}) {
  if (strudelScopeReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (strudelScopeReady()) return resolve();
      if (performance.now() - started > timeoutMs) {
        return reject(new Error('[strudel-faust] Strudel scope did not appear on globalThis'));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
