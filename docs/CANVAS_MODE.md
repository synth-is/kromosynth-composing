# Canvas mode — a branching graph for composition (design)

**Status: design / exploration — not built.** Sibling to `DISCOVERY_AND_EXECUTION.md`
(why the app has both pedagogical features and an LLM) and `AI_EDIT_PLAN.md` (how the
linear Ask-AI edit works). This is the "what if the timeline were a graph" exploration —
an *optional* mode you switch to; the linear pad + trajectory stays the default.

## Thesis

The trajectory is already a lineage of versions — it's just constrained to a single path.
Canvas mode lifts that constraint: a DAG where a version can have several parents and
several children. **The linear timeline is one path through the canvas.** So the canvas
isn't a replacement; it's the same object with the single-path constraint removed, and any
path traced through it is still a playable/scrubbable linear trajectory.

Inspiration (not adoption): the Obsidian plugins `obsidian-canvas-llm` and
`obsidian-chat-stream` (visual branching LLM chats over text/file/URL nodes). Prior art in
our own research lineage: Earle, Arulkumaran, Dai, Kumar, Togelius & Risi, *In Search of the
Ingredients of Open-Endedness: Replicating Picbreeder with Large Vision-Language Models*
(GECCO 2026, arXiv:2605.23908, <https://arxiv.org/abs/2605.23908>) — a branching archive
with a model in the selection loop. Its findings are direct design hints for our
generation/scoring loop: inject subtle agent-persona diversity, keep a little memory to
avoid repetition, add a bit of exploratory noise. The manual (human-picks) version is plain
IEC; Picbreeder is the canonical IEC example. The spectrum is clean: **IEC (you pick) →
AI-assisted selection (the paper's move) → automated QD (a map + a quality theory).**

## Node types

- **Sound node** — a kit sound. Carries a spectrogram/waveform preview and an extracted
  text description (tags). Contributes *both* a playable sample and its description to
  whatever is generated downstream.
- **Prompt / text node** — free-text context ("sparse, dubby, 7/8").
- **Pattern node** — Strudel code + metadata + a preview thumbnail. Audio is serial (you
  can't skim twelve patterns the way you skim twelve text nodes), so the thumbnail matters —
  you *see* the shape and quick-audition rather than playing everything.
- **Combine / stack node** — layers or merges several pattern nodes (two flavours below).
- **Target node** *(later)* — a descriptor/prompt used as a scoring target.

## Edges

An edge always means **"upstream is an ingredient / context for what's generated
downstream."** Uniform semantics; a generation synthesizes whatever is upstream of it. That
uniformity is what keeps the model simple.

Edges are **typed, with a per-edge UI toggle**:

- **feeds / derives-from** (solid) — lineage. `sound → pattern` (ingredient),
  `prompt → pattern` (context), `pattern → pattern` (branch/derive).
- **plays-with** (dashed) — simultaneity. The armed set that sounds together, or that feeds
  a combine node.

Why keep the two distinct: the graph encodes **derivation** (this pattern came from that
one); a performance encodes **simultaneity** (these sound together, synced). They're
orthogonal — a pure derivation graph can't express "play these three at once." The toggle
(and the combine node) is how simultaneity is expressed without polluting lineage.

## The atomic op: "fit a sound in"

The seed of the whole thing, and shippable in the **linear app first** (no canvas needed):

> sound (its tags) + optional prompt + the current pattern → a new pattern that arranges the
> sound in.

One `askEdit`-shaped call — reuses `lib/llm.js`, `buildReference`, the BYO endpoint, and
provenance stamping. On the canvas it becomes *composable*: the output is a node you branch
from, and the incoming edges are just its ingredients.

**Describe step (audio → tags).** The CLAP service (`features/clap/ws_clap_service.py`)
exposes a text branch returning text embeddings in the *same shared space* as its audio
embeddings. So zero-shot tags = cosine(the sound's stored CLAP embedding, a cached
descriptor-vocabulary text-embedding matrix) → top-k. Implementation notes:

- Best home: a small `describe` endpoint in `kromosynth-recommend`, reusing the per-sound
  CLAP embedding it already stores (no re-render, no audio round-trip). Embed the curated
  vocabulary once and cache it.
- **Correctness:** embed the vocabulary with the *same* checkpoint that produced the stored
  audio embeddings (hub production LAION-CLAP), **not** the `32057` HTSAT-base benchmark
  worker — mismatched checkpoints don't share a space.
- **Honesty about the signal:** a curated *timbral* vocabulary (bright / metallic / gritty /
  plucked / evolving / sustained…) is the workhorse. QD-run class labels are unreliable for
  abstract evolved timbres; off-the-shelf audio-LMs are speech/event-centric and are a later,
  possibly-underwhelming experiment for pure timbre, not the starting point.

## The combine node — two flavours (maps onto the bounce wall)

- **(a) Live / synced** — run the inputs as several synchronised Strudel REPLs (feasible:
  Biome units and community jam-grids already do multi-REPL sync). Independent live control,
  good for jamming. Combined capture still hits the multi-engine bounce wall → tab-audio
  workaround. Only an *armed subset* sounds at once; you choose which.
- **(b) Merge-to-one-program** — stack the upstream patterns' code into a single Strudel
  program → one engine → *bounce-able*. The merge itself is a natural LLM job ("fit these
  into one coherent stacked piece").

Composition vs performance is left open because it's genuinely both: (b) leans "piece"
(save it, send stems to Live), (a) leans "jam."

## Playback model

Nodes hold code + metadata + preview; an *armed subset* are live synced REPLs. The single
focused editor (the existing pad) edits whichever node is focused, and the palette /
select-transform / explain-this / Ask-AI all act on that focused node. The canvas is the
map; the pad is the workbench.

## Scoring loop / QD-on-canvas (horizon)

Once a pattern is rendered, re-embed it with CLAP and score it against a **target node**
(distance-to-target) or an **intrinsic** quality (acoustic Order/Complexity — no target
needed). That is MAP-Elites over *arrangements*: a pattern node is the genome (code + kit),
an LLM branch is variation, the CLAP embedding is the behaviour descriptor, the target or
O/C is the objective. It reuses the existing CVT/grid + multi-encoder + O/C stack, pointed
at compositions instead of timbres.

This is the same "what is quality / diversity?" question from the IQD framing, now asked of
arrangements — distance-to-prompt vs O/C vs compression-progress → the same swappable
`constitutiveTheory`. The Picbreeder-VLM levers (agent-persona diversity, memory,
exploratory noise) inform how the loop explores rather than collapses.

Manual version first: a target node and "here's how close each branch landed." Full
automated QD-over-compositions is a research horizon.

## MVP vs deferred

**MVP:**
- Node types: sound, prompt/text, pattern — plus a combine/stack node.
- Typed edges with a per-edge toggle (feeds/derives vs plays-with).
- The "fit a sound in" generation (reusing `llm.js` + `buildReference` + BYO endpoint +
  provenance) as the act that mints pattern nodes.
- Describe-a-sound via CLAP zero-shot tags (a `describe` endpoint in `recommend`).
- Arm a subset of nodes as synced live REPLs; the focused node drives the pad/palette/Ask-AI.

**Deferred:** audio-LM captioning; the CLAP-scoring / QD overlay and target nodes;
LLM-merge quality; file/URL nodes; combined-performance bounce.

## Continuity (what this reuses)

Almost nothing is from scratch: trajectory → graph; kit → sound nodes; `askEdit` / `llm.js`
→ the fit-in "compose" call (context assembled from a node's graph-ancestors, same
`buildReference`, same BYO endpoint, same provenance); the environments abstraction →
generalises to Csound / WebChucK; `kromosynth-recommend` → the `describe` endpoint over
already-stored CLAP embeddings.
