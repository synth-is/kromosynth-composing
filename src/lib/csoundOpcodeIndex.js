/**
 * The opcode surface of the pinned @csound/browser build.
 *
 * PLACEHOLDER — replace this whole file with the output of the "Export index"
 * button in the Csound spike (?csound=1, section 4), which writes a
 * `csoundOpcodeIndex.js` ready to drop in here.
 *
 * Until then `OPCODE_INDEX` is null and lib/csoundOpcodes.js falls back to building
 * the index at runtime with `libcsound()`. That fallback works, but it stands up a
 * SECOND Csound wasm runtime beside the live engine, and doing so mid-performance
 * has killed the browser tab outright — so it is a stopgap, not the design.
 *
 * The file exists even while empty because a dynamic import of a missing module is
 * a Vite build error, not a catchable runtime 404.
 *
 * Regenerate whenever @csound/browser is bumped, at the same time as re-running the
 * concept harness. The generated file carries a `version` field and is ignored,
 * with a warning, if it doesn't match CSOUND_REFERENCE_VERSION.
 */

export const OPCODE_INDEX = null;
