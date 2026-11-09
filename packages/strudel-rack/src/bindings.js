/**
 * bindings.js — how this package reaches a Strudel instance WITHOUT importing one.
 * Same rule as @kromosynth/strudel-faust (see its bindings.js for the full story): there can be
 * two live Strudel instances in a page (the <strudel-editor>'s inlined one and the app's own),
 * so sounds register into whichever scope `deps` points at — usually globalThis after the editor's
 * prebake assigned @strudel/webaudio's exports there.
 */

const REQUIRED = ['registerSound', 'getAudioContext'];
const PATTERN_DEPS = ['Pattern', 'reify'];
const OPTIONAL = ['getFrequencyFromValue'];

function pick(names, injected) {
  const out = {};
  const missing = [];
  for (const name of names) {
    const found = injected?.[name] ?? globalThis[name];
    if (found) out[name] = found;
    else missing.push(name);
  }
  return { out, missing };
}

export function resolveBindings(injected) {
  const { out, missing } = pick([...REQUIRED, ...PATTERN_DEPS, ...OPTIONAL], injected);
  if (missing.some((n) => REQUIRED.includes(n))) {
    throw new Error(
      `[strudel-rack] Strudel scope not ready — missing ${missing.join(', ')}. ` +
      'Register after the editor\'s prebake, or pass { registerSound, getAudioContext, Pattern, reify } in deps.',
    );
  }
  return { ...out, logger: injected?.logger ?? globalThis.logger };
}

export function strudelScopeReady() {
  return REQUIRED.every((n) => !!globalThis[n]);
}
