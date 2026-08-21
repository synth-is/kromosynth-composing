/**
 * Opcodes worth stumbling into.
 *
 * The point of the surprise action is to reach parts of Csound that decades of
 * development put there and that nobody finds by browsing an alphabetical list.
 * But a uniform draw from the 2346 opcodes in the index mostly returns plumbing —
 * assignment, type conversion, array handling, printing. So this is a wish list,
 * hand-picked for being GENERATIVE: things that make or transform sound in a way
 * you would notice.
 *
 * It is only a wish list. At runtime `pickSurprise()` intersects it with the
 * opcode index, so anything this build doesn't have simply never comes up, and the
 * spike can report which entries are missing. That way the list can be ambitious
 * without risking a suggestion that cannot compile.
 *
 * The one-line descriptions are our own, written to say what the thing DOES in
 * terms a person could act on — not transcribed from the manual (docs/CSOUND_PLAN.md
 * §4 rule 1, §12). They go into the AI instruction, so they need to be accurate
 * about function rather than evocative.
 *
 * No imports on purpose: this is plain data, and lib/environments.js reaches it
 * without dragging the wasm into the main bundle.
 */

export const SURPRISE_PALETTE = [
  // ---- Granular: sound as a cloud of fragments ----
  { name: 'syncgrain', blurb: 'plays a table as a stream of short grains at a rate you set' },
  { name: 'sndwarp', blurb: 'stretches time and shifts pitch independently by overlapping windows' },
  { name: 'mincer', blurb: 'phase-vocoder playback where a pointer sets the position and pitch is separate' },
  { name: 'temposcal', blurb: 'time-scales a table with independent tempo and pitch control' },
  { name: 'grain3', blurb: 'granular synthesis with direct control over grain phase and randomisation' },
  { name: 'grain', blurb: 'a simple grain generator with random density and amplitude' },
  { name: 'diskgrain', blurb: 'granular synthesis reading straight off a soundfile' },
  { name: 'partikkel', blurb: 'a very deep granular engine — every property of every grain is controllable' },
  { name: 'fof', blurb: 'formant grains: overlapping bursts that produce vowel-like tones' },
  { name: 'fof2', blurb: 'formant grains whose position in a stored sound you can move' },
  { name: 'syncloop', blurb: 'looping granular playback with synchronised grains' },
  { name: 'waveset', blurb: 'repeats individual wave cycles — a rough, characterful stretch' },

  // ---- Spectral: taking the sound apart by frequency ----
  { name: 'pvscross', blurb: 'cross-synthesis: gives one sound the spectral shape of another' },
  { name: 'pvsmorph', blurb: 'morphs between two spectral streams' },
  { name: 'pvsblur', blurb: 'averages the spectrum over time so transients dissolve' },
  { name: 'pvsfreeze', blurb: 'holds the spectrum still — a moment stretched indefinitely' },
  { name: 'pvscale', blurb: 'transposes by scaling frequencies, leaving the timing alone' },
  { name: 'pvshift', blurb: 'shifts all frequencies by a fixed amount, breaking the harmonic series' },
  { name: 'pvsmooth', blurb: 'smooths amplitude and frequency separately over time' },
  { name: 'pvsfilter', blurb: 'uses one spectrum as a filter shape for another' },
  { name: 'pvsbandp', blurb: 'a band-pass applied in the spectral domain, with very steep edges' },
  { name: 'pvsarp', blurb: 'emphasises one spectral bin and suppresses the rest' },
  { name: 'pvstencil', blurb: 'gates spectral bins against a stored template — spectral noise removal' },
  { name: 'pvsvoc', blurb: 'vocoder: the amplitudes of one sound on the frequencies of another' },

  // ---- Physical models: instruments simulated rather than sampled ----
  { name: 'wgbow', blurb: 'a bowed string — friction, pressure and position rather than an envelope' },
  { name: 'wgflute', blurb: 'a flute modelled as an air jet against a tube' },
  { name: 'wgclar', blurb: 'a clarinet modelled as a reed on a tube' },
  { name: 'wgbrass', blurb: 'a brass instrument modelled with lip tension' },
  { name: 'wgpluck2', blurb: 'a plucked string with control over pluck position and damping' },
  { name: 'barmodel', blurb: 'a struck bar or plate, from stiffness and boundary conditions' },
  { name: 'prepiano', blurb: 'a prepared piano string — objects resting on it change the timbre' },
  { name: 'gogobel', blurb: 'a struck tuned bell or gong' },
  { name: 'marimba', blurb: 'a struck wooden bar with its resonator' },
  { name: 'vibes', blurb: 'a struck metal bar with its resonator' },
  { name: 'mandol', blurb: 'a plucked mandolin, including the double courses' },
  { name: 'shaker', blurb: 'a shaken container of small objects' },
  { name: 'bamboo', blurb: 'colliding bamboo tubes — a wind-chime rattle' },
  { name: 'dripwater', blurb: 'water drops, from a particle model' },
  { name: 'guiro', blurb: 'a scraped ridged surface' },
  { name: 'sekere', blurb: 'a shaken gourd rattle' },
  { name: 'tambourine', blurb: 'a struck tambourine, jingles and all' },
  { name: 'crunch', blurb: 'the sound of something being crushed' },

  // ---- Filters and resonators ----
  { name: 'mode', blurb: 'a single resonant mode — stack a few and you have built a bell' },
  { name: 'streson', blurb: 'a string resonator: makes anything ring at a pitch' },
  { name: 'zdf_ladder', blurb: 'a zero-delay-feedback ladder filter, stable at high resonance' },
  { name: 'diode_ladder', blurb: 'a diode ladder filter — the acidic one' },
  { name: 'K35_lpf', blurb: 'a Sallen-Key low-pass that distorts as it resonates' },
  { name: 'statevar', blurb: 'a state-variable filter giving all outputs at once' },
  { name: 'svfilter', blurb: 'low, high and band-pass from one filter, simultaneously' },
  { name: 'vlowres', blurb: 'a resonant low-pass with a deliberately unstable character' },
  { name: 'rezzy', blurb: 'a sharply resonant filter that will self-oscillate' },
  { name: 'clfilt', blurb: 'classic filter designs — Butterworth, Chebyshev, elliptic' },
  { name: 'hilbert', blurb: 'splits a signal into two 90°-apart copies, the basis of frequency shifting' },

  // ---- Delay, space and colour ----
  { name: 'freeverb', blurb: 'a warm, cheap reverb with room size and damping' },
  { name: 'nreverb', blurb: 'a networked reverb with configurable comb and allpass times' },
  { name: 'babo', blurb: 'a physical room model — you place the source and listener in a box' },
  { name: 'spat3d', blurb: 'positions a sound in three dimensions, with early reflections' },
  { name: 'hrtfmove2', blurb: 'places a sound around your head using ear-shape modelling' },
  { name: 'flanger', blurb: 'a very short modulated delay mixed back in — a sweeping comb' },
  { name: 'phaser1', blurb: 'a chain of allpass filters producing moving notches' },
  { name: 'phaser2', blurb: 'phasing with control over how the notches are spaced' },
  { name: 'multitap', blurb: 'a delay with several taps at times and levels you choose' },
  { name: 'comb', blurb: 'a delay with feedback, which rings at a pitch set by its length' },
  { name: 'alpass', blurb: 'an allpass delay: changes phase but not the spectrum — reverb building block' },
  { name: 'distort1', blurb: 'waveshaping distortion with separate control of the two halves' },
  { name: 'harmon', blurb: 'tracks the pitch and adds harmonised copies' },

  // ---- Movement from chaos and randomness ----
  { name: 'lorenz', blurb: 'the Lorenz attractor as three signals — deterministic but never repeating' },
  { name: 'chuap', blurb: "Chua's circuit: a chaotic oscillator from analogue electronics" },
  { name: 'rspline', blurb: 'random values joined by smooth curves at a rate that itself varies' },
  { name: 'jspline', blurb: 'jitter-spline: smooth random drift between bounds' },
  { name: 'gauss', blurb: 'random numbers clustered around the middle rather than spread evenly' },
  { name: 'betarand', blurb: 'random numbers you can skew toward either end of the range' },
  { name: 'cauchy', blurb: 'random numbers with occasional wild outliers' },

  // ---- Sequencing and control ----
  { name: 'seqtime', blurb: 'reads a table of durations to trigger events — a step sequencer' },
  { name: 'loopseg', blurb: 'a looping envelope built from segments, at a rate you control' },
  { name: 'lpshold', blurb: 'a looping stepped envelope — a sample-and-hold sequencer' },
  { name: 'trigseq', blurb: 'steps through a table of trigger values' },
  { name: 'follow2', blurb: 'tracks a signal\u2019s loudness with separate attack and release' },
  { name: 'pitchamdf', blurb: 'estimates the pitch of a signal so you can play something else with it' },
  { name: 'compress2', blurb: 'a compressor with threshold, ratio, knee and lookahead' },
  { name: 'dam', blurb: 'a compressor/expander that can duck one sound under another' },
];
