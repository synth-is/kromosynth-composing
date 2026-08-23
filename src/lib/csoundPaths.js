/**
 * Where kit sounds live inside Csound's virtual filesystem.
 *
 * Deliberately its own module with NO dependencies. Two callers need it:
 *
 *  - lib/csoundEngine.js, which writes the files, and
 *  - lib/environments.js + lib/concepts.js, which GENERATE CODE referencing them
 *    by name — and which App.jsx imports on every page load. Importing the engine
 *    there would pull @csound/browser (and its wasm) into the main bundle for
 *    people who only ever open the Strudel tab.
 *
 * The path is a plain constant rather than something conditional. Every snippet
 * the palette, the starters and the AI produce hard-codes it, so a path that could
 * silently differ at runtime would break all of them at once. If `/kit` can't be
 * created, that's an error worth surfacing — not a reason to quietly write
 * somewhere else.
 */

export const KIT_DIR = '/kit';

/** The filename an orchestra references, e.g. diskin2 "/kit/textural.wav", 1 */
export function kitFilePath(name) {
  return `${KIT_DIR}/${name}.wav`;
}
