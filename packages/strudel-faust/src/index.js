/**
 * @kromosynth/strudel-faust — play evolved Faust instruments from Strudel.
 *
 *   await faustSounds({ bellish: dspSource });
 *   note("c3 e3 g3").s("bellish").fp({ cutMul: "<2 6 12>" }).lpf(900).room(.4)
 *
 * Registered as a SOUND rather than as a pattern method, unlike
 * @strudel/csound: a Faust worklet is an ordinary AudioNode, so superdough can
 * wire gain, filters, pan, delay, room, orbits and analysers around it, and the
 * offline bounce works without a second scheduling path. Csound has to own its
 * own output (`-odac`) and therefore cannot.
 */

import { getGenerator, describeSource, warmSource } from './compiler.js';
import { buildParamPlan, patternableNames } from './params.js';
import { createLiveVoice } from './voice-live.js';
import { renderOfflineVoice } from './voice-offline.js';
import { resolveBindings } from './bindings.js';

/**
 * Merge one patterned value into a hap's faustParams.
 *
 * `withValue(...).appLeft(reify(v))` is Strudel's own idiom for "structure from
 * the left, values from the right" — the same shape core uses for .partials and
 * .phases. Merging key by key (rather than .set()) is what lets .fp() chain
 * without each call clobbering the last one's parameters.
 */
function mergeParam(reify, pat, name, value) {
  return pat
    .withValue((v) => (pv) => ({ ...v, faustParams: { ...(v.faustParams || {}), [name]: pv } }))
    .appLeft(reify(value));
}

/**
 * A slider name has to survive the transpiler.
 *
 * @strudel/transpiler's mini plugin rewrites EVERY double-quoted string literal
 * into a mini-notation pattern (plugin-mini.mjs: `node.raw[0] === '"'`). So in
 * the REPL, .fp("cutMul", …) hands us a Pattern where a name was meant. The
 * object form .fp({ cutMul: … }) is immune, because an identifier key is not a
 * Literal node — which is why it is the form the docs lead with. Single quotes
 * also work. A double-quoted constant is unwrapped here rather than rejected,
 * since that is unambiguous; anything with real pattern structure is not, and
 * says so.
 */
function asName(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x.queryArc === 'function') {
    try {
      const values = [...new Set(x.queryArc(0, 1).map((h) => h.value))];
      if (values.length === 1 && typeof values[0] === 'string') return values[0];
    } catch { /* fall through to the error below */ }
    throw new Error(
      '[strudel-faust] .fp(): the slider name became a pattern. In the REPL every ' +
      'double-quoted string is mini-notation — write .fp({ cutMul: "<2 6>" }) or ' +
      ".fp('cutMul', \"<2 6>\").",
    );
  }
  throw new Error(`[strudel-faust] .fp(): expected a slider name, got ${typeof x}`);
}

/**
 * Install `.fp` on a Strudel instance's Pattern class.
 *
 * Assigned to Pattern.prototype directly rather than through register(),
 * because register() curries to a fixed arity and .fp is variadic — the object
 * form takes one argument and the pair form takes two. Core does the same for
 * its own variadic methods (.FX, .worklet, .partials).
 */
export function installFp(deps) {
  const { Pattern, reify } = deps;
  if (!Pattern || !reify) {
    deps.logger?.(
      '[strudel-faust] Pattern/reify not available — sounds are registered but .fp() is not installed.',
      'warning',
    );
    return false;
  }
  if (Pattern.prototype.fp) return false;
  Pattern.prototype.fp = function fp(...args) {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && typeof args[0].queryArc !== 'function') {
      return Object.entries(args[0]).reduce(
        (pat, [name, value]) => mergeParam(reify, pat, String(name).toLowerCase(), value),
        this,
      );
    }
    if (args.length >= 2) {
      return mergeParam(reify, this, asName(args[0]).toLowerCase(), args[1]);
    }
    throw new Error("[strudel-faust] .fp() takes ({ name: value, … }) or ('name', value)");
  };
  return true;
}

const REGISTERED = new Map();

/**
 * Register one instrument.
 *
 * @param name    what `s("…")` will say. superdough lowercases keys and turns
 *                whitespace into underscores, so it is normalised here too and
 *                the normalised name is returned.
 * @param source  a self-contained Faust `.dsp` program — a 0-input generator
 *                declaring freq/gain/gate. From kromosynth, that is exactly
 *                what faustGenomeToDSP() emits.
 */
export async function registerFaustSound(name, source, options = {}) {
  const deps = options.deps ? resolveBindings(options.deps) : resolveBindings();
  const key = String(name).toLowerCase().replace(/\s+/g, '_');

  const info = await describeSource(source);
  if (info.numInputs !== 0) {
    throw new Error(
      `[strudel-faust] "${key}" takes ${info.numInputs} audio input(s) — it is an effect, not a voice. ` +
      'Only 0-input generators can be played as a sound.',
    );
  }
  const plan = buildParamPlan(info);
  if (!plan.gate) {
    deps.logger?.(`[strudel-faust] "${key}" has no gate widget — Faust prunes widgets that reach no output, so notes will not articulate.`, 'warning');
  }

  const voiceOptions = {
    velocityToGain: options.velocityToGain,
    releaseTail: options.releaseTail,
    maxTail: options.maxTail,
    silenceThreshold: options.silenceThreshold,
  };

  deps.registerSound(
    key,
    async (t, value, onended) => {
      const ctx = deps.getAudioContext();
      const args = { ctx, source, plan, instrument: key, t, value, onended, deps, options: voiceOptions };
      // The whole two-backend design, in one line. An OfflineAudioContext means
      // the bounce; see voice-offline.js for why the worklet cannot serve it.
      return ctx instanceof OfflineAudioContext
        ? renderOfflineVoice(args)
        : createLiveVoice(args);
    },
    { type: 'faust', prebake: false },
  );

  REGISTERED.set(key, { source, plan, sliders: patternableNames(plan) });
  if (options.warm !== false) await warmSource(source, 1);
  return key;
}

/**
 * Register a map of instruments, mirroring `samples({ name: url })`.
 *
 * Call this TWICE, exactly as the kit is registered twice: once into the
 * editor's scope before playing, and once into the app's own instance before
 * a bounce. See bindings.js for why one registration cannot serve both.
 */
export async function faustSounds(map, options = {}) {
  const deps = options.deps ? resolveBindings(options.deps) : resolveBindings();
  installFp(deps);
  const names = [];
  for (const [name, source] of Object.entries(map || {})) {
    names.push(await registerFaustSound(name, source, { ...options, deps }));
  }
  return names;
}

/** What sliders does a registered instrument expose to .fp()? */
export function faustSliders(name) {
  return REGISTERED.get(String(name).toLowerCase())?.sliders ?? null;
}

export function registeredFaustSounds() {
  return [...REGISTERED.keys()];
}

export {
  ensureFaust,
  setFaustWasmUrl,
  setFaustWasmModule,
  getGenerator,
  warmSource,
  createFaustNode,
  createFaustOfflineProcessor,
  describeSource,
  resolveParamPath,
  clearFactoryCache,
  setFactoryCacheSize,
  factoryCacheStats,
} from './compiler.js';

export { scheduleAtTime } from './schedule.js';
export { setGateLatency, getGateLatency } from './voice-live.js';
export { buildParamPlan, patternableNames, resetParamWarnings, RESERVED } from './params.js';
export { resolveBindings, strudelScopeReady, whenStrudelScopeReady } from './bindings.js';
