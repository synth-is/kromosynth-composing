# Discovery and execution — why the composition area has both a palette and an LLM

This is the "why" companion to `AI_EDIT_PLAN.md` (the "how"). It records the conceptual split
between the composition area's pedagogical features and its Ask-AI feature: why we offer an LLM
connection at all, what each mode is for, and the stance the LLM option takes.

## Thesis

**The pedagogical features lead you to things you wouldn't have thought to ask for. The LLM
connection is for the things you're ready to ask for.** Discovery vs execution — complementary,
not either/or.

## Why an LLM at all — and why it isn't mission drift

Synth.is is an assistive, human-in-the-loop platform: a *feeder* of novel, grown-not-sampled
material, not an autopilot. A text-to-audio generator would be mission drift — it would replace
the discovery engine's job with a black box. An LLM that edits *your* pattern code, on *your*
explicit instruction, and lands as a reversible step *you* curate, is not: it's the same
assistive posture one layer up — acting on the pattern language, never on the sounds.

Two concrete reasons it earns its place:

- **Live coding has a cold-start problem** — a blank editor plus an unfamiliar language. The
  pedagogical features soften that from one side (showing what's possible); the LLM softens it
  from the other (letting you state intent in plain English before you've learned the
  vocabulary).
- **The model never touches the sounds.** It rewrites Strudel (and later Csound / ChucK) code.
  The sounds stay genomes — grown, not sampled. The LLM is a text-to-code assistant scoped to
  the pattern layer, nothing more.

## The two modes

**Pedagogical (discovery).** The concept palette (a browsable menu of what's possible, each with
a live example built from your kit), select-and-transform (one-click transforms on a selection —
chop, reverse, add reverb…), and explain-this (a plain-English decode of your own code). These
are the menu for someone who doesn't yet know what to ask for. They teach by doing, on your own
material; they're bounded, predictable, and always correct (curated transforms). Their cost is
that you have to browse, and they can only offer what we've curated.

**LLM / Ask-AI (execution).** A plain-English box — "make the bass hit the offbeat," "give this
an ADSR envelope," "chop this and gate it" — that rewrites the selection or the whole buffer and
lands as a reversible trajectory step. This is the tool for when you already know the change you
want and don't want to hunt the menu. It's open-ended and expressive, but fallible (a model can
emit code that errors or misreads intent) — which is exactly why it's reversible and
provenance-stamped.

## Where they hand off

Discovery has no cold-start cost and can't go wrong, but it's bounded to what we've curated and
it requires browsing. Execution has no browsing cost and no vocabulary prerequisite, but it can
misfire and needs a model endpoint. They compose naturally: browse the palette to learn that
`chop` exists and hear what it does; later, once "chop this into eight and gate it" is already in
your head, just say it. Explain-this closes the loop — it teaches you to read what the LLM (or
you) wrote, feeding back into fluency.

## Use cases

Reach for the **pedagogical** features when:

- you don't yet know what the language can do (→ palette);
- you want to understand a snippet you copied or were given (→ explain-this);
- you want a variation but don't know the function name (→ select-and-transform);
- you're building fluency by hearing concepts on your own sounds.

Reach for the **LLM** when:

- you know the change and just want it done: offbeat bass, add an envelope, transpose up a
  fifth, restructure into an A/B arrangement;
- the edit is multi-step and tedious by hand;
- you're fluent enough to think in intent rather than syntax.

## The stance: bring-your-own, local-first, transparent

- **Bring-your-own endpoint.** Point it at a local model (LM Studio on your own machine) or a
  cloud provider with your own key. Provider / base URL / model / key live only in the user's
  browser `localStorage`; the platform never sees them; there is no shared, baked-in key. The
  feature is off until the user sets it up.
- **Local-first fits the ethos** — private, free, no lock-in — the same instinct as
  grown-not-sampled and browser-based accessibility.
- **Provenance on every step.** Each AI edit is a labelled, reversible trajectory snapshot,
  stamped with the model/endpoint that produced it. You always see what changed, can undo it,
  and know what made it.
- **Version-matched knowledge.** The model's language reference is derived from our own concept
  library and pinned to the bundled Strudel version, so it doesn't invent functions the shipped
  version lacks. (See `AI_EDIT_PLAN.md` §4 and §6.)

## Why this shape — external grounding

This split isn't arbitrary. Garcia & Reiss, *An investigation of AI integration in sound designer
workflows and experiences* (AES 2026 Int. Conf. on Audio for VR/AR & Immersive Games, Paris;
arXiv:2605.27174 — <https://arxiv.org/abs/2605.27174>), surveyed 76 practitioners and interviewed
20, and found a consistent preference for assistive, task-specific, human-in-the-loop tools that
keep the practitioner as curator over end-to-end generation — and that practitioners treat data
provenance and the "black box" problem as a *governing* condition for adoption, not a nicety. The
composition area's design — pedagogical discovery plus an assistive, reversible,
provenance-stamped, bring-your-own-endpoint LLM edit — is deliberately shaped to that finding.

## Generalises

Because the LLM reads the *active environment's* reference (derived from that language's concept
library), the same Ask-AI feature will work for Csound-WASM and WebChucK when they land, with no
special-casing. The per-language concept list does double duty: it powers the palette *and* the
LLM reference. (See `AI_EDIT_PLAN.md` §5.)
