/**
 * Onboarding / learning concept library, per live-coding environment.
 *
 * One entry can feed three surfaces:
 *   - the browsable Concepts palette      -> `example(names)` (a snippet from the kit)
 *   - select-and-transform quick actions  -> `apply(selected)` (wraps the selection)
 *   - "explain this"                       -> `match` (regex that detects the concept)
 *
 * We deliberately generate examples from the user's own kit sounds and write the
 * explanations in our own words — teaching the ideas the Strudel docs teach,
 * without reproducing their prose. `docsUrl` links out for the real thing.
 */

import { kitFilePath } from './csoundPaths.js';

// Strudel concepts. `quick: true` marks the highest-value select-transforms that
// surface directly in the selection bar; the palette shows everything.
export const STRUDEL_CONCEPTS = [
  // ---- Rhythm ----
  {
    id: 'sequence', category: 'Rhythm', label: 'Sequence',
    explain: 'Play sounds one after another — they share the cycle evenly.',
    example: (n) => `s("${n.a} ${n.b} ${n.c}")`,
  },
  {
    id: 'repeat', category: 'Rhythm', label: 'Repeat', quick: true,
    explain: 'Play something several times per cycle (a*4 = four times).',
    example: (n) => `s("${n.a}*4")`,
    apply: (s) => `${s}*2`,
    match: /\*\s*\d/,
  },
  {
    id: 'euclid', category: 'Rhythm', label: 'Euclidean',
    explain: 'Spread N hits as evenly as possible across M steps — instant grooves.',
    example: (n) => `s("${n.a}(3,8)")`,
    match: /\(\s*\d+\s*,\s*\d+\s*\)/,
  },
  {
    id: 'rest', category: 'Rhythm', label: 'Rest',
    explain: 'Use ~ for a silent step, to carve out space.',
    example: (n) => `s("${n.a} ~ ${n.b} ~")`,
    match: /~/,
  },
  {
    id: 'ply', category: 'Rhythm', label: 'Subdivide (ply)', quick: true,
    explain: 'Repeat each event in place N times — like a quick roll.',
    apply: (s) => `${s}.ply(2)`,
    match: /\.ply\s*\(/,
  },

  // ---- Structure ----
  {
    id: 'alternate', category: 'Structure', label: 'Alternate', quick: true,
    explain: 'Play a different option on each cycle: <a b> gives a, then b, then a…',
    example: (n) => `s("<${n.a} ${n.b}>")`,
    apply: (s) => `<${s}>`,
    match: /<[^>]+>/,
  },
  {
    id: 'cat', category: 'Structure', label: 'One-per-cycle (cat)',
    explain: 'Play whole patterns one per cycle, in turn.',
    example: (n) => `cat(\n  s("${n.a}*4"),\n  s("${n.b} ${n.c}")\n)`,
    match: /\bcat\s*\(/,
  },

  // ---- Layering ----
  {
    id: 'stack', category: 'Layering', label: 'Layer (stack)', quick: true,
    explain: 'Play several patterns at once — the way you build a full groove.',
    example: (n) => `stack(\n  s("${n.a}*2"),\n  s("${n.b} ${n.c}")\n)`,
    apply: (s) => `stack(\n  ${s},\n  ${s}\n)`,
    match: /\bstack\s*\(/,
  },
  {
    id: 'jux', category: 'Layering', label: 'Stereo split (jux)', quick: true,
    explain: 'Apply a transform to only one stereo side — wide, dubby movement.',
    example: (n) => `s("${n.a}*4").jux(rev)`,
    apply: (s) => `${s}.jux(rev)`,
    match: /\.jux\s*\(/,
  },

  // ---- Melody ----
  {
    id: 'note', category: 'Melody', label: 'Pitches (note)',
    explain: 'Play named pitches instead of raw hits.',
    example: (n) => `note("c e g a").s("${n.a}")`,
    match: /\bnote\s*\(/,
  },
  {
    id: 'scale', category: 'Melody', label: 'Scale',
    explain: 'Turn plain numbers into a musical scale — 0 1 2 stay in key.',
    example: (n) => `n("0 2 4 6").scale("C:minor").s("${n.a}")`,
    match: /\.scale\s*\(/,
  },
  {
    id: 'transpose', category: 'Melody', label: 'Transpose over time',
    explain: 'Shift the pitches as the piece goes, for a changing melody.',
    example: (n) => `n("0 2 4".add("<0 3 5>")).scale("C:minor").s("${n.a}")`,
    match: /\.add\s*\(/,
  },

  // ---- Motion ----
  {
    id: 'fast', category: 'Motion', label: 'Faster', quick: true,
    explain: 'Speed the pattern up (2 = twice as fast).',
    example: (n) => `s("${n.a} ${n.b}").fast(2)`,
    apply: (s) => `${s}.fast(2)`,
    match: /\.fast\s*\(/,
  },
  {
    id: 'slow', category: 'Motion', label: 'Slower', quick: true,
    explain: 'Stretch the pattern out (2 = half speed).',
    example: (n) => `s("${n.a} ${n.b}").slow(2)`,
    apply: (s) => `${s}.slow(2)`,
    match: /\.slow\s*\(/,
  },
  {
    id: 'rev', category: 'Motion', label: 'Reverse', quick: true,
    explain: 'Play the pattern backwards.',
    example: (n) => `s("${n.a} ${n.b} ${n.c}").rev()`,
    apply: (s) => `${s}.rev()`,
    match: /\.rev\s*\(/,
  },
  {
    id: 'every', category: 'Motion', label: 'Every N cycles', quick: true,
    explain: 'Run a transform once every N cycles — variation without extra code.',
    example: (n) => `s("${n.a}*4").every(4, fast(2))`,
    apply: (s) => `${s}.every(4, rev)`,
    match: /\.every\s*\(/,
  },
  {
    id: 'swing', category: 'Motion', label: 'Swing', quick: true,
    explain: 'Nudge off-beats late for a swung, human feel.',
    apply: (s) => `${s}.swingBy(1/3, 4)`,
    match: /\.swing/,
  },

  // ---- Tone & space ----
  {
    id: 'gain', category: 'Tone & space', label: 'Volume', quick: true,
    explain: 'Set how loud it is (0–1).',
    example: (n) => `s("${n.a}*4").gain(.7)`,
    apply: (s) => `${s}.gain(.7)`,
    match: /\.gain\s*\(/,
  },
  {
    id: 'lpf', category: 'Tone & space', label: 'Darker (low-pass)', quick: true,
    explain: 'Roll off the highs for a darker, warmer tone.',
    example: (n) => `s("${n.a}*4").lpf(800)`,
    apply: (s) => `${s}.lpf(800)`,
    match: /\.(lpf|cutoff)\s*\(/,
  },
  {
    id: 'hpf', category: 'Tone & space', label: 'Thinner (high-pass)',
    explain: 'Cut the lows to thin a sound out or make room for a bass.',
    apply: (s) => `${s}.hpf(500)`,
    match: /\.hpf\s*\(/,
  },
  {
    id: 'room', category: 'Tone & space', label: 'Reverb', quick: true,
    explain: 'Add space around the sound.',
    example: (n) => `s("${n.a} ${n.b}").room(.4)`,
    apply: (s) => `${s}.room(.4)`,
    match: /\.room\s*\(/,
  },
  {
    id: 'delay', category: 'Tone & space', label: 'Echo', quick: true,
    explain: 'Add repeating echoes.',
    example: (n) => `s("${n.a} ${n.b}").delay(.4)`,
    apply: (s) => `${s}.delay(.4)`,
    match: /\.delay\s*\(/,
  },
  {
    id: 'adsr', category: 'Tone & space', label: 'Shape (envelope)',
    explain: 'Shape the fade-in/out of each note (attack / release).',
    apply: (s) => `${s}.attack(.01).release(.2)`,
    match: /\.(attack|release|decay|sustain)\s*\(/,
  },
  {
    id: 'pan', category: 'Tone & space', label: 'Pan',
    explain: 'Move the sound across the stereo field.',
    apply: (s) => `${s}.pan(sine)`,
    match: /\.pan\s*\(/,
  },

  // ---- Chance ----
  {
    id: 'degrade', category: 'Chance', label: 'Thin out (random)', quick: true,
    explain: 'Randomly drop some events, so a busy pattern breathes.',
    example: (n) => `s("${n.a}*8").degradeBy(.3)`,
    apply: (s) => `${s}.degradeBy(.3)`,
    match: /\.degrade/,
  },
  {
    id: 'sometimes', category: 'Chance', label: 'Sometimes', quick: true,
    explain: 'Apply a transform only some of the time, at random.',
    apply: (s) => `${s}.sometimesBy(.3, fast(2))`,
    match: /\.sometimes/,
  },
  {
    id: 'choose', category: 'Chance', label: 'Pick randomly',
    explain: 'Choose randomly between options each time.',
    example: (n) => `s(choose("${n.a}", "${n.b}", "${n.c}"))`,
    match: /\bchoose\s*\(/,
  },

  // ---- Sampling / chopping (great for the longer evolved textures) ----
  {
    id: 'chop', category: 'Sampling', label: 'Chop', quick: true,
    explain: 'Chop a sound into N pieces played in order — turn a long texture into a rhythm.',
    example: (n) => `s("${n.a}").chop(8)`,
    apply: (s) => `${s}.chop(8)`,
    match: /\.chop\s*\(/,
  },
  {
    id: 'slice', category: 'Sampling', label: 'Slice & reorder', quick: true,
    explain: 'Cut into N slices, then play them in any order you like.',
    example: (n) => `s("${n.a}").slice(8, "0 2 1 3 4 6 5 7")`,
    apply: (s) => `${s}.slice(8, "0 2 1 3")`,
    match: /\.slice\s*\(/,
  },
  {
    id: 'striate', category: 'Sampling', label: 'Striate (granular)', quick: true,
    explain: 'Interleave N slices across the cycle — a granular, shimmering read of the sound.',
    example: (n) => `s("${n.a}").striate(16)`,
    apply: (s) => `${s}.striate(16)`,
    match: /\.striate\s*\(/,
  },
  {
    id: 'loopAt', category: 'Sampling', label: 'Fit to cycles', quick: true,
    explain: 'Stretch a sample to fill N cycles, so a loop locks to the tempo.',
    example: (n) => `s("${n.a}").loopAt(2)`,
    apply: (s) => `${s}.loopAt(2)`,
    match: /\.loopAt\s*\(/,
  },
  {
    id: 'range', category: 'Sampling', label: 'Play a portion',
    explain: 'Play just part of the sample (0–1 of its length).',
    example: (n) => `s("${n.a}").begin(0.25).end(0.75)`,
    apply: (s) => `${s}.begin(0.25).end(0.75)`,
    match: /\.(begin|end)\s*\(/,
  },
  {
    id: 'chopshuffle', category: 'Sampling', label: 'Chop + reverse',
    explain: 'Chop, then reverse the order of the pieces for a glitchy re-read.',
    example: (n) => `s("${n.a}").chop(8).rev()`,
    apply: (s) => `${s}.chop(8).rev()`,
  },

  // ---- more Motion ----
  {
    id: 'off', category: 'Motion', label: 'Offset echo', quick: true,
    explain: 'Layer a time-shifted copy of the pattern — a canon or echo.',
    example: (n) => `s("${n.a}*4").off(1/8, x => x.speed(2))`,
    apply: (s) => `${s}.off(1/8, x => x.speed(2))`,
    match: /\.off\s*\(/,
  },
  {
    id: 'superimpose', category: 'Motion', label: 'Layer a variation',
    explain: 'Play the pattern plus a transformed copy of itself, together.',
    example: (n) => `s("${n.a}*4").superimpose(fast(2))`,
    apply: (s) => `${s}.superimpose(fast(2))`,
    match: /\.superimpose\s*\(/,
  },
  {
    id: 'chunk', category: 'Motion', label: 'Rotating transform',
    explain: 'Apply a transform to a different chunk of the pattern each cycle.',
    example: (n) => `s("${n.a}*4").chunk(4, fast(2))`,
    apply: (s) => `${s}.chunk(4, fast(2))`,
    match: /\.chunk\s*\(/,
  },
  {
    id: 'filtersweep', category: 'Motion', label: 'Filter sweep (LFO)', quick: true,
    explain: 'Sweep the low-pass filter with a slow LFO for wobble and movement.',
    example: (n) => `s("${n.a}*8").lpf(sine.range(300, 2000).slow(4))`,
    apply: (s) => `${s}.lpf(sine.range(300, 2000).slow(4))`,
  },

  // ---- more Tone & space ----
  {
    id: 'vowel', category: 'Tone & space', label: 'Vowel filter', quick: true,
    explain: 'A formant / vowel filter for a vocal, talking quality.',
    example: (n) => `s("${n.a}*4").vowel("<a e i o>")`,
    apply: (s) => `${s}.vowel("<a e i>")`,
    match: /\.vowel\s*\(/,
  },
  {
    id: 'crush', category: 'Tone & space', label: 'Bit-crush', quick: true,
    explain: 'Reduce bit depth for lo-fi, crunchy grit.',
    example: (n) => `s("${n.a}*4").crush(4)`,
    apply: (s) => `${s}.crush(4)`,
    match: /\.crush\s*\(/,
  },
  {
    id: 'shape', category: 'Tone & space', label: 'Distortion',
    explain: 'Waveshaping distortion — warmth or edge.',
    example: (n) => `s("${n.a}*4").shape(.4)`,
    apply: (s) => `${s}.shape(.4)`,
    match: /\.shape\s*\(/,
  },
  {
    id: 'coarse', category: 'Tone & space', label: 'Downsample',
    explain: 'Sample-rate reduction for a crunchy, aliased tone.',
    example: (n) => `s("${n.a}*4").coarse(4)`,
    apply: (s) => `${s}.coarse(4)`,
    match: /\.coarse\s*\(/,
  },

  // ---- Harmony (chords & arpeggios) ----
  {
    id: 'chord', category: 'Harmony', label: 'Chord',
    explain: 'Play several pitches at once, and move between chords per cycle.',
    example: (n) => `note("<c'maj a'min f'maj g'maj>").s("${n.a}")`,
    match: /'(maj|min|m7|maj7|dom7|7|sus2|sus4|dim|aug|add9)|\bchord\s*\(/,
  },
  {
    id: 'arp', category: 'Harmony', label: 'Arpeggiate',
    explain: 'Spread a chord out into an arpeggio.',
    example: (n) => `note("<c'maj a'min>").arp("<up down updown>").s("${n.a}")`,
    apply: (s) => `${s}.arp("up")`,
    match: /\.arp\s*\(/,
  },

  // ---- Polyrhythm / polymeter ----
  {
    id: 'polyrhythm', category: 'Rhythm', label: 'Polyrhythm',
    explain: 'Two different subdivisions filling the same cycle — e.g. 3 against 4.',
    example: (n) => `s("[${n.a}*3, ${n.b}*4]")`,
  },
  {
    id: 'polymeter', category: 'Rhythm', label: 'Polymeter',
    explain: 'Stack patterns of different lengths that step through and drift against each other.',
    example: (n) => `s("{${n.a} ${n.b}, ${n.c} ${n.a} ${n.b}}")`,
    match: /\{[^}]*\}/,
  },

  // ---- Structural gating ----
  {
    id: 'struct', category: 'Structure', label: 'Impose a rhythm (struct)', quick: true,
    explain: 'Give a sound a rhythm with a true/false pattern (1 = hit, 0 = rest).',
    example: (n) => `s("${n.a}").struct("1 0 1 1 0 1 0 0")`,
    apply: (s) => `${s}.struct("1 0 1 1")`,
    match: /\.struct\s*\(/,
  },
  {
    id: 'mask', category: 'Structure', label: 'Gate (mask)', quick: true,
    explain: 'Silence parts of a pattern with a true/false gate, keeping its own timing.',
    example: (n) => `s("${n.a}*8").mask("<1 1 0 1>")`,
    apply: (s) => `${s}.mask("1 1 0 1")`,
    match: /\.mask\s*\(/,
  },

  // ---- Modulation (LFOs & signals) ----
  {
    id: 'tremolo', category: 'Modulation', label: 'Tremolo (LFO)', quick: true,
    explain: 'Pulse the volume up and down with an LFO.',
    example: (n) => `s("${n.a}*8").gain(sine.range(0.4, 1).fast(2))`,
    apply: (s) => `${s}.gain(sine.range(0.4, 1).fast(2))`,
  },
  {
    id: 'autopan', category: 'Modulation', label: 'Auto-pan (LFO)', quick: true,
    explain: 'Sweep the sound across the stereo field with an LFO.',
    example: (n) => `s("${n.a}*4").pan(sine.slow(2))`,
    apply: (s) => `${s}.pan(sine.slow(2))`,
  },
  {
    id: 'drift', category: 'Modulation', label: 'Random drift (perlin)', quick: true,
    explain: 'Modulate a parameter with smooth randomness for organic movement.',
    example: (n) => `s("${n.a}*8").speed(perlin.range(0.9, 1.1))`,
    apply: (s) => `${s}.speed(perlin.range(0.9, 1.1))`,
    match: /\bperlin\b/,
  },

  // ---- Arrangement (build a piece over time) ----
  {
    id: 'stackparts', category: 'Arrangement', label: 'Play parts together',
    explain: 'Name a few parts and layer them so they sound at the same time (only the last expression plays — so make it one stack).',
    example: (n) => `let drums = s("${n.a}*4")\nlet bass = s("${n.b}(3,8)")\nstack(drums, bass)`,
  },
  {
    id: 'arrange', category: 'Arrangement', label: 'Arrange sections',
    explain: 'Play different parts for a number of cycles each — the start of a song.',
    example: (n) => `let a = s("${n.a}*4")\nlet b = s("${n.b}(3,8)").room(.3)\narrange([4, a], [4, b], [4, stack(a, b)])`,
    match: /\barrange\s*\(/,
  },

  // ---- Control / MIDI (play & control from hardware) ----
  {
    id: 'midi-keys', category: 'Control / MIDI', label: 'Play with a MIDI keyboard',
    explain: 'Trigger a sound by pressing keys on a MIDI keyboard. Swap in your device name (use Detect above).',
    example: (n) => `const kb = await midikeys('Your Keyboard')\nkb().s("${n.a}").lpf(1200).room(.3)`,
    match: /\bmidikeys\s*\(/,
  },
  {
    id: 'midi-knob', category: 'Control / MIDI', label: 'Map a knob to a parameter',
    explain: 'Twist a physical knob (CC 74 here) to sweep a parameter live. Set your device name and CC number.',
    example: (n) => `const cc = await midin('Your Controller')\ns("${n.a}*8").lpf(cc(74).range(200, 4000))`,
    match: /\bmidin\s*\(/,
  },
  {
    id: 'midi-out', category: 'Control / MIDI', label: 'Send notes to a synth / DAW',
    explain: 'Send the pattern out as MIDI notes to hardware or a DAW (leave the name blank for the first device).',
    example: (n) => `note("<c e g a>").midi('IAC Driver')`,
    match: /\.midi\s*\(/,
  },
  {
    id: 'midi-clock', category: 'Control / MIDI', label: 'Sync a DAW to Strudel',
    explain: 'Send MIDI clock + start/stop so your DAW or drum machine follows Strudel’s tempo.',
    example: (n) => `midicmd("clock*48,<start stop>/2").midi('IAC Driver')`,
    match: /\bmidicmd\s*\(/,
  },
];

// Csound concepts. Unlike Strudel's one-liners, every example here is a COMPLETE
// playable buffer — orchestra plus score — because that is what "Insert" replaces
// and what the pad plays. Each one comments itself: docs/CSOUND_PLAN.md §12,
// "generated code carries its own teaching".
//
// EVERY example is checked against the bundled build by the spike's "Validate all
// concepts" button before it ships. Nothing in here is written from memory and
// left unverified — a wrong example in a learning tool is worse than a missing one,
// because the reader can't tell our mistake from theirs.
const CS_HEADER = 'ksmps = 32\nnchnls = 2\n0dbfs = 1';

/** Assemble a complete buffer: header + orchestra + score. */
function csBuf(orc, sco) {
  return `${CS_HEADER}\n\n${orc}\n\n<CsScore>\n${sco}\n</CsScore>`;
}

export const CSOUND_CONCEPTS = [
  // ---- Instrument basics ----
  {
    id: 'cs-instr', category: 'Instrument basics', label: 'An instrument',
    explain: 'Everything between instr and endin is one instrument. The score decides when it runs.',
    example: () => csBuf(
`; An instrument is a recipe for a sound. It makes no noise on its own —
; something has to ask for it, which is what the score below does.
instr 1
  ; poscil is a pure tone: amplitude, then frequency in Hz.
  aSig poscil 0.2, 220
  ; out sends audio to the speakers, one argument per channel.
  out aSig, aSig
endin`,
`; i <instrument> <start> <duration>
i 1 0 2`),
    match: /\binstr\b[\s\S]*\bendin\b/,
  },
  {
    id: 'cs-rates', category: 'Instrument basics', label: 'a, k and i — the three rates',
    explain: 'A name\u2019s first letter says how often it changes: a every sample, k every few hundred, i once.',
    example: () => csBuf(
`instr 1
  ; iFreq is set ONCE when the note starts and never changes.
  iFreq = 220
  ; kSweep changes at control rate — often enough to hear as movement,
  ; cheap enough to be free. line: from, over how long, to.
  kSweep line 1, p3, 4
  ; aSig changes every single sample: it IS the sound.
  aSig poscil 0.15, iFreq * kSweep
  out aSig, aSig
endin`,
`i 1 0 3`),
    match: /\bk[A-Z]\w*\s+(line|linseg|expseg)\b/,
  },
  {
    id: 'cs-pfields', category: 'Instrument basics', label: 'p-fields — values from the score',
    explain: 'Each number on a score line arrives in the instrument as p1, p2, p3… so one instrument can play many ways.',
    example: () => csBuf(
`instr 1
  ; p1 is the instrument, p2 the start, p3 the duration — always.
  ; p4 onward are yours to name and use. Here p4 is a frequency.
  aSig poscil 0.15, p4
  out aSig, aSig
endin`,
`; Same instrument, three different notes — only p4 changes.
i 1 0.0 0.5 220
i 1 0.5 0.5 330
i 1 1.0 1.0 440`),
    match: /\bp[4-9]\b/,
  },
  {
    id: 'cs-envelope', category: 'Instrument basics', label: 'Give it a shape (linen)',
    explain: 'A raw tone clicks at both ends. An envelope fades it in and out.',
    example: () => csBuf(
`instr 1
  ; linen: peak level, attack time, total length, release time.
  ; Passing p3 as the length makes it fit whatever the score asks for.
  ; Try 0.5 for the attack — it turns a hit into a swell.
  aEnv linen 0.2, 0.01, p3, 0.3
  aSig poscil aEnv, 220
  out aSig, aSig
endin`,
`i 1 0 2`),
    match: /\blinen\b/,
  },
  {
    id: 'cs-schedule', category: 'Instrument basics', label: 'Fire events from code',
    explain: 'schedule books a note from inside an instrument — the start time counts from now, not from the beginning.',
    example: () => csBuf(
`instr 1
  aEnv linen 0.15, 0.005, p3, 0.05
  aSig poscil aEnv, p4
  out aSig, aSig
endin

; instr 99 makes no sound. Its body runs ONCE, the moment it starts, and
; each schedule books an event that many seconds FROM NOW.
instr 99
  ;        instrument, when, how long, p4
  schedule 1, 0.0, 0.4, 220
  schedule 1, 0.5, 0.4, 330
  schedule 1, 1.0, 0.4, 440
endin`,
`; The score only has to start the one instrument that writes the rest.
i 99 0 0.1`),
    match: /\bschedule\b/,
  },

  // ---- Playing your kit ----
  {
    id: 'cs-diskin', category: 'Playing your kit', label: 'Play one of your sounds',
    explain: 'diskin2 reads a soundfile by name from Csound\u2019s filesystem. Your kit lives there.',
    example: (n) => csBuf(
`instr 1
  ; The path is the kit name — the file was written in when you added the sound.
  ; The second argument is the playback rate: 1 = exactly as recorded.
  ; Kit sounds are MONO, so diskin2 has one output here.
  aSig diskin2 "${kitFilePath(n.a)}", 1
  aEnv linen 0.4, 0.005, p3, 0.05
  out aSig * aEnv, aSig * aEnv
endin`,
`i 1 0 2`),
    match: /\bdiskin2\b/,
  },
  {
    id: 'cs-rate', category: 'Playing your kit', label: 'Change the pitch and speed',
    explain: 'The playback rate transposes and stretches together, the way a tape machine does.',
    example: (n) => csBuf(
`instr 1
  ; p4 is the rate. 2 reads through the file twice as fast, an octave up.
  ; 0.5 is an octave down. Negative values read it BACKWARDS.
  ; How long the note lasts is p3 — the rate only changes how much of the
  ; file you get through in that time.
  aSig diskin2 "${kitFilePath(n.a)}", p4
  aEnv linen 0.4, 0.005, p3, 0.05
  out aSig * aEnv, aSig * aEnv
endin`,
`i 1 0.0 0.6 1
i 1 0.6 0.6 0.5
i 1 1.2 0.6 1.5
i 1 1.8 0.6 2`),
  },
  {
    id: 'cs-skip', category: 'Playing your kit', label: 'Start part-way in',
    explain: 'Skip into the file to grab the interesting bit instead of the attack.',
    example: (n) => csBuf(
`instr 1
  ; Third argument: how many seconds to skip before playing.
  ; p4 carries it from the score so you can hunt for the good part.
  aSig diskin2 "${kitFilePath(n.a)}", 1, p4
  aEnv linen 0.4, 0.02, p3, 0.1
  out aSig * aEnv, aSig * aEnv
endin`,
`; Same sound, four different starting points.
i 1 0.0 0.5 0.0
i 1 0.5 0.5 0.5
i 1 1.0 0.5 1.0
i 1 1.5 0.5 1.5`),
  },
  {
    id: 'cs-layer', category: 'Playing your kit', label: 'Two sounds at once',
    explain: 'Adding signals means adding levels too — every kit sound is normalised, so scale down or you clip.',
    example: (n) => csBuf(
`instr 1
  aOne diskin2 "${kitFilePath(n.a)}", 1
  aTwo diskin2 "${kitFilePath(n.b)}", 1
  ; Both files peak near full scale. Summed they would reach 2.0, and
  ; 0dbfs is 1.0 — hence the 0.35. Csound prints "samples out of range"
  ; in the log if you get this wrong.
  aMix = (aOne + aTwo) * 0.35
  aEnv linen 1, 0.01, p3, 0.1
  out aMix * aEnv, aMix * aEnv
endin`,
`i 1 0 3`),
  },
  {
    id: 'cs-perinstr', category: 'Playing your kit', label: 'One instrument per sound',
    explain: 'Give each kit sound its own instrument number, then the score reads like a drum pattern.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", p4
  aEnv linen 0.3, 0.005, p3, 0.05
  out aSig * aEnv, aSig * aEnv
endin

instr 2
  aSig diskin2 "${kitFilePath(n.b)}", p4
  aEnv linen 0.3, 0.005, p3, 0.05
  out aSig * aEnv, aSig * aEnv
endin`,
`; Two lanes. Read the first column downward and it is a rhythm.
i 1 0.0 0.3 1
i 2 0.3 0.3 1
i 1 0.6 0.3 1
i 2 0.9 0.3 1.5
i 1 1.2 0.3 1
i 2 1.5 0.3 0.75`),
  },
  {
    id: 'cs-loop', category: 'Playing your kit', label: 'Make it repeat',
    explain: 'A score ends. To keep going, an instrument books itself again one bar ahead.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", p4
  aEnv linen 0.3, 0.005, p3, 0.05
  out aSig * aEnv, aSig * aEnv
endin

; This is the whole trick. instr 99 lays out one bar, and its last line
; books ANOTHER COPY OF ITSELF one bar ahead. That copy does the same.
; Delete that line and the bar plays once and stops — both are valid.
instr 99
  schedule 1, 0.0, 0.4, 1
  schedule 1, 0.4, 0.4, 1.5
  schedule 1, 0.8, 0.4, 2
  schedule 99, 1.2, 0.1
endin`,
`i 99 0 0.1`),
  },

  // ---- Filters ----
  {
    id: 'cs-moogladder', category: 'Filters', label: 'Low-pass with resonance',
    explain: 'Remove the top of a sound and emphasise what\u2019s left at the cutoff. The classic synth filter.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  aEnv linen 0.5, 0.005, p3, 0.05
  ; moogladder: signal, cutoff in Hz, resonance 0–1.
  ; Push resonance past 0.8 and the filter starts to whistle at the cutoff.
  aOut moogladder aSig * aEnv, p4, 0.4
  out aOut, aOut
endin`,
`; Same sound, four cutoffs — hear the top disappear.
i 1 0.0 0.6 6000
i 1 0.6 0.6 2000
i 1 1.2 0.6 700
i 1 1.8 0.6 250`),
    match: /\bmoogladder\b/,
  },
  {
    id: 'cs-sweep', category: 'Filters', label: 'Sweep the filter',
    explain: 'Move the cutoff while the note plays and a static sound becomes a gesture.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  aEnv linen 0.5, 0.01, p3, 0.1
  ; expseg moves in exponential steps, which is how we hear pitch and
  ; brightness — a linear sweep sounds lopsided. from, over, to.
  kCut expseg 300, p3 * 0.7, 5000, p3 * 0.3, 400
  aOut moogladder aSig * aEnv, kCut, 0.5
  out aOut, aOut
endin`,
`i 1 0 4`),
    match: /\bexpseg\b/,
  },
  {
    id: 'cs-reson', category: 'Filters', label: 'Band-pass — pick out one region',
    explain: 'Keep a narrow band and throw the rest away. Narrow enough and it rings at that pitch.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  aEnv linen 0.5, 0.005, p3, 0.05
  ; reson: signal, centre frequency, bandwidth, scaling mode.
  ; Mode 1 keeps the level sane; without it a narrow band gets very loud.
  ; p5 is the bandwidth — try 20 for a ringing tone, 800 for a colour.
  aOut reson aSig * aEnv, p4, p5, 1
  out aOut, aOut
endin`,
`i 1 0.0 0.8 400 600
i 1 0.8 0.8 400 40
i 1 1.6 0.8 1600 40`),
    match: /\breson\b/,
  },

  // ---- Effects ----
  {
    id: 'cs-reverb', category: 'Effects', label: 'Reverb',
    explain: 'Put the sound in a room. Keep a dry copy and mix the wet one under it.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  aEnv linen 0.4, 0.005, p3, 0.05
  aDry = aSig * aEnv
  ; reverbsc takes a stereo pair in and gives a stereo pair out.
  ; Third argument is feedback — room size, really. 0.9 is a big hall.
  ; Fourth is a cutoff: lower it and the tail gets darker.
  aWetL, aWetR reverbsc aDry, aDry, 0.85, 8000
  ; p3 is long so the tail has room to decay before the note ends.
  out aDry * 0.7 + aWetL * 0.4, aDry * 0.7 + aWetR * 0.4
endin`,
`i 1 0 6`),
    match: /\breverbsc\b/,
  },
  {
    id: 'cs-delay', category: 'Effects', label: 'Echo',
    explain: 'Delayed copies underneath the original. You only hear them as echoes if the source stops — so keep it short.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  ; A short blip, not the whole sound. Most kit sounds are sustained
  ; textures, and an echo hidden under a texture just thickens it — you
  ; need silence after the source to hear the repeats at all.
  ; linseg: start, time, value, time, value… and it holds the last one.
  aEnv linseg 0, 0.005, 0.5, 0.25, 0
  aDry = aSig * aEnv
  ; vdelay: signal, delay in MILLISECONDS, maximum delay to reserve.
  ; Three taps, each later and quieter — that decay is what makes it
  ; sound like a room rather than three separate copies.
  aE1 vdelay aDry, 300, 1200
  aE2 vdelay aDry, 600, 1200
  aE3 vdelay aDry, 900, 1200
  aMix = aDry + aE1 * 0.6 + aE2 * 0.36 + aE3 * 0.2
  out aMix, aMix
endin`,
`; The note lasts 2 s so the last tap has room to sound.
i 1 0 2`),
    match: /\bvdelay\b/,
  },
  {
    id: 'cs-pan', category: 'Effects', label: 'Place it in the stereo field',
    explain: 'pan2 turns one signal into a stereo pair. Move the position and the sound travels.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  aEnv linen 0.4, 0.005, p3, 0.05
  ; kPos runs 0 (hard left) to 1 (hard right) across the note.
  kPos line 0, p3, 1
  aL, aR pan2 aSig * aEnv, kPos
  out aL, aR
endin`,
`i 1 0 3`),
    match: /\bpan2\b/,
  },

  // ---- Movement ----
  {
    id: 'cs-lfo', category: 'Movement', label: 'Wobble it (LFO)',
    explain: 'A slow oscillator used as a control value rather than as sound.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  ; A k-rate poscil below ~20 Hz is an LFO — too slow to hear as a pitch,
  ; fast enough to hear as movement. It swings between -0.3 and +0.3,
  ; so adding 0.7 keeps the level positive: 0.4 to 1.0.
  kWob poscil 0.3, 5
  aEnv linen 0.4, 0.01, p3, 0.1
  aOut = aSig * aEnv * (0.7 + kWob)
  out aOut, aOut
endin`,
`i 1 0 3`),
  },
  {
    id: 'cs-random', category: 'Movement', label: 'Random drift',
    explain: 'Wander a parameter between two values instead of choosing one. Organic rather than mechanical.',
    example: (n) => csBuf(
`instr 1
  ; randomi picks new random values and glides between them:
  ; minimum, maximum, times per second.
  ; Each note lands somewhere different — play it a few times.
  kCut randomi 400, 4000, 3
  aSig diskin2 "${kitFilePath(n.a)}", 1
  aEnv linen 0.4, 0.005, p3, 0.05
  aOut moogladder aSig * aEnv, kCut, 0.3
  out aOut, aOut
endin`,
`i 1 0.0 0.8 1
i 1 0.8 0.8 1
i 1 1.6 0.8 1`),
    match: /\brandomi\b/,
  },
  {
    id: 'cs-linseg', category: 'Movement', label: 'Envelopes with more than one stage',
    explain: 'linen gives you in and out. linseg lets you draw any shape in as many steps as you like.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  ; linseg: start value, time, next value, time, next value…
  ; This is a fast attack, a drop to a quiet sustain, then a slow fade —
  ; the shape of a plucked string. Add another pair to add a stage.
  aEnv linseg 0, 0.01, 0.5, 0.1, 0.15, p3 - 0.11, 0
  out aSig * aEnv, aSig * aEnv
endin`,
`i 1 0 3`),
    match: /\blinseg\b/,
  },

  // ---- Function tables (unlocks loscil, flooper2, mincer, granular…) ----
  {
    id: 'cs-ftgen', category: 'Function tables', label: 'Load a sound into a table',
    explain: 'A table is a sound held in memory rather than read off disk — which unlocks looping, granular and phase-vocoder opcodes.',
    example: (n) => csBuf(
`; A function table is a block of memory Csound reads from. GEN01 fills one
; from a soundfile. The 0 for size means "as long as the file is".
; This line lives OUTSIDE any instrument — it runs once, at load.
giSnd ftgen 0, 0, 0, 1, "${kitFilePath(n.a)}", 0, 0, 0

instr 1
  ; loscil reads the table instead of the file: amplitude, pitch ratio,
  ; table, and the base frequency the table is assumed to be at.
  aSig loscil 0.4, p4, giSnd, 1
  aEnv linen 1, 0.005, p3, 0.05
  out aSig * aEnv, aSig * aEnv
endin`,
`i 1 0.0 0.6 1
i 1 0.6 0.6 1.5
i 1 1.2 0.6 0.75`),
    match: /\bftgen\b/,
  },
  {
    id: 'cs-flooper', category: 'Function tables', label: 'Loop a slice of it',
    explain: 'Pick a start and end inside the sound and loop between them, crossfading so the seam doesn\u2019t click.',
    example: (n) => csBuf(
`giSnd ftgen 0, 0, 0, 1, "${kitFilePath(n.a)}", 0, 0, 0

instr 1
  ; flooper2: amplitude, pitch, loop start (s), loop end (s),
  ; crossfade (s), table.
  ; Move the start and end and you are sampling a texture out of your sound.
  aSig flooper2 0.4, p4, 0.2, 1.2, 0.05, giSnd
  aEnv linen 1, 0.05, p3, 0.2
  out aSig * aEnv, aSig * aEnv
endin`,
`i 1 0 4 1`),
    match: /\bflooper2\b/,
  },
  {
    id: 'cs-mincer', category: 'Function tables', label: 'Stretch time without changing pitch',
    explain: 'A phase vocoder reads the sound at whatever speed you like while pitch stays put — or the other way round.',
    example: (n) => csBuf(
`giSnd ftgen 0, 0, 0, 1, "${kitFilePath(n.a)}", 0, 0, 0

instr 1
  ; aTime is a POINTER, in seconds, into the sound. Here it crawls across
  ; the first two seconds over the whole note — so a 2 s sound takes p3.
  ; Slow it further and you get a drone made of your own material.
  aTime line 0, p3, 2
  ; mincer: time pointer, amplitude, pitch, table, lock.
  ; p4 is the pitch, INDEPENDENT of the speed above. That is the point.
  aSig mincer aTime, 0.5, p4, giSnd, 1
  aEnv linen 1, 0.05, p3, 0.2
  out aSig * aEnv, aSig * aEnv
endin`,
`; Same speed, three pitches.
i 1 0 6 1
i 1 0 6 1.5
i 1 0 6 0.5`),
    match: /\bmincer\b/,
  },

  // ---- Oscillators ----
  {
    id: 'cs-vco2', category: 'Oscillators', label: 'Classic waveforms',
    explain: 'vco2 makes saw, square and triangle without the harsh aliasing a naive oscillator gives.',
    example: () => csBuf(
`instr 1
  ; vco2: amplitude, frequency. The default is a sawtooth — add a third
  ; argument to pick another shape (try 10 for a square).
  aSig vco2 0.15, p4
  aEnv linen 1, 0.01, p3, 0.1
  aOut moogladder aSig * aEnv, 1200, 0.3
  out aOut, aOut
endin`,
`i 1 0.0 0.5 110
i 1 0.5 0.5 165
i 1 1.0 1.0 82.5`),
    match: /\bvco2\b/,
  },
  {
    id: 'cs-fm', category: 'Oscillators', label: 'FM from two oscillators',
    explain: 'Use one oscillator to wobble another\u2019s frequency. Slow it and it\u2019s vibrato; speed it up and it becomes timbre.',
    example: () => csBuf(
`instr 1
  ; p4 = pitch, p5 = how far the modulator pushes (the "index"),
  ; p6 = the modulator's frequency as a ratio of the carrier's.
  ; Whole-number ratios sound harmonic; 1.41 sounds like a bell.
  aMod poscil p5, p4 * p6
  aEnv linen 0.2, 0.01, p3, 0.3
  aSig poscil aEnv, p4 + aMod
  out aSig, aSig
endin`,
`;         pitch  index  ratio
i 1 0.0 0.8 220 50    1
i 1 0.8 0.8 220 300   1
i 1 1.6 1.2 220 400   1.41`),
  },
  {
    id: 'cs-noise', category: 'Oscillators', label: 'Noise, then carve it',
    explain: 'Noise contains every frequency, so a narrow filter can pull any tone out of it.',
    example: () => csBuf(
`instr 1
  ; noise: amplitude, and a colour control (0 = white).
  aNz noise 0.4, 0
  ; A narrow band-pass turns hiss into a pitched ring.
  aOut reson aNz, p4, 30, 1
  aEnv linen 1, 0.005, p3, 0.2
  out aOut * aEnv, aOut * aEnv
endin`,
`i 1 0.0 0.4 400
i 1 0.4 0.4 600
i 1 0.8 0.8 900`),
    match: /\bnoise\b/,
  },

  // ---- Chords and arrangement ----
  {
    id: 'cs-chord', category: 'Chords & arrangement', label: 'Play a chord',
    explain: 'Several notes at the same start time. Naming them by MIDI number makes the intervals obvious.',
    example: () => csBuf(
`instr 1
  ; cpsmidinn turns a MIDI note number into Hz. 60 is middle C,
  ; and +12 is an octave — so the arithmetic stays musical.
  aSig vco2 0.08, cpsmidinn(p4)
  aEnv linen 1, 0.02, p3, 0.4
  aOut moogladder aSig * aEnv, 1500, 0.2
  out aOut, aOut
endin

instr 99
  ; A minor triad: root, +3 semitones, +7.
  schedule 1, 0, 2, 57
  schedule 1, 0, 2, 60
  schedule 1, 0, 2, 64
  ; Change 60 to 61 and the chord turns major.
endin`,
`i 99 0 0.1`),
    match: /\bcpsmidinn\b/,
  },
  {
    id: 'cs-sections', category: 'Chords & arrangement', label: 'Bars that change',
    explain: 'Let the clock count bars and decide what to play. This is where a loop becomes a piece.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", p4
  aEnv linen 0.3, 0.005, p3, 0.05
  out aSig * aEnv, aSig * aEnv
endin

instr 99
  ; p4 is a bar counter. The clock passes p4 + 1 to its next copy,
  ; so it knows how far into the piece it is.
  iBar = p4
  if iBar < 2 then
    ; First two bars: sparse.
    schedule 1, 0.0, 0.4, 1
    schedule 1, 0.8, 0.4, 1
  else
    ; After that: busier, and rising.
    schedule 1, 0.0, 0.4, 1
    schedule 1, 0.4, 0.4, 1.5
    schedule 1, 0.8, 0.4, 2
    schedule 1, 1.2, 0.4, 3
  endif
  schedule 99, 1.6, 0.1, iBar + 1
endin`,
`; The last number is the starting bar.
i 99 0 0.1 0`),
    match: /\bif\b[\s\S]*\bendif\b/,
  },
  {
    id: 'cs-send', category: 'Chords & arrangement', label: 'One reverb for everything',
    explain: 'Instruments write into a shared bus; a single always-on instrument reverberates the lot. Cheaper and more coherent than one reverb each.',
    example: (n) => csBuf(
`; Global a-rate variables (ga…) are visible to every instrument — a bus.
gaSendL init 0
gaSendR init 0

instr 1
  aSig diskin2 "${kitFilePath(n.a)}", p4
  aEnv linen 0.3, 0.005, p3, 0.05
  aOut = aSig * aEnv
  out aOut, aOut
  ; Add to the bus rather than replacing it, or voices erase each other.
  gaSendL = gaSendL + aOut * 0.4
  gaSendR = gaSendR + aOut * 0.4
endin

; Instruments run in NUMBER ORDER each control cycle, so 100 sees everything
; instrument 1 wrote this cycle. That is why the effect gets a high number.
instr 100
  aL, aR reverbsc gaSendL, gaSendR, 0.88, 7000
  out aL * 0.6, aR * 0.6
  ; Empty the bus, or it feeds back and grows forever.
  gaSendL = 0
  gaSendR = 0
endin`,
`; p3 of -1 means "hold until stopped" — the effect stays up the whole time.
i 100 0 -1
i 1 0.0 0.4 1
i 1 0.6 0.4 1.5
i 1 1.2 0.4 2`),
    match: /\bga[A-Z]\w*/,
  },

  // ---- Spectral ----
  {
    id: 'cs-freeze', category: 'Spectral', label: 'Freeze the spectrum',
    explain: 'Take the sound apart into frequencies, hold them still, and put it back together — a moment stretched indefinitely.',
    example: (n) => csBuf(
`instr 1
  aSig diskin2 "${kitFilePath(n.a)}", 1
  ; pvsanal turns audio into a stream of spectral frames (an "fsig").
  ; FFT size, overlap, window size, window type. Bigger FFT = finer
  ; frequency detail but smearier in time.
  fSig pvsanal aSig, 1024, 256, 1024, 1
  ; Above 0.5 these hold amplitude and frequency where they are. The ramp
  ; means the sound gradually stops moving and becomes a chord.
  kHold line 0, p3, 1
  fHeld pvsfreeze fSig, kHold, kHold
  ; pvsynth turns the frames back into audio.
  aOut pvsynth fHeld
  aEnv linen 0.6, 0.05, p3, 0.5
  out aOut * aEnv, aOut * aEnv
endin`,
`i 1 0 6`),
    match: /\bpvsanal\b/,
  },

  // ---- Live coding ----
  {
    id: 'cs-chn', category: 'Live coding', label: 'Control channels',
    explain: 'A named channel any running instrument can read — the hook for knobs, or for one instrument to steer another.',
    example: (n) => csBuf(
`instr 1
  ; chnget reads a named channel. Nothing is writing "cutoff" yet, so it
  ; reads 0 — limit clamps that into something audible.
  kCut chnget "cutoff"
  kCut limit kCut, 300, 8000
  aSig diskin2 "${kitFilePath(n.a)}", 1
  aEnv linen 0.4, 0.005, p3, 0.05
  aOut moogladder aSig * aEnv, kCut, 0.3
  out aOut, aOut
endin

instr 2
  ; …and chnset writes one. An instrument whose only job is to move a
  ; number is a perfectly good instrument.
  kSweep line 300, p3, 6000
  chnset kSweep, "cutoff"
endin`,
`i 2 0 4
i 1 0 4`),
    match: /\bchn(get|set)\b/,
  },

  // ---- Select-and-transform (no standalone example; they wrap a selection) ----
  {
    id: 'cs-lowpass', category: 'Shaping a signal', label: 'Low-pass filter', quick: true,
    explain: 'Select an audio variable, then wrap it in a resonant low-pass. Arguments: cutoff Hz, resonance 0–1.',
    apply: (s) => `moogladder(${s}, 800, 0.3)`,
    match: /\bmoogladder\b/,
  },
  {
    id: 'cs-quieter', category: 'Shaping a signal', label: 'Quieter', quick: true,
    explain: 'Halve the level of the selected signal — the fix when Csound reports samples out of range.',
    apply: (s) => `(${s} * 0.5)`,
  },
  {
    id: 'cs-tremolo', category: 'Shaping a signal', label: 'Tremolo', quick: true,
    explain: 'Multiply the selection by a wobbling level so it pulses 4 times a second.',
    apply: (s) => `(${s} * (0.6 + poscil(0.4, 4)))`,
  },
];

const REGISTRY = { strudel: STRUDEL_CONCEPTS, csound: CSOUND_CONCEPTS };

export function getConcepts(envId = 'strudel') {
  // `|| STRUDEL_CONCEPTS` only catches ids we don't know about; a registered but
  // empty list ([]) is truthy and passes through as itself.
  return REGISTRY[envId] || STRUDEL_CONCEPTS;
}

/** Whether this environment has a concept library yet — gates the palette and the AI. */
export function hasConcepts(envId = 'strudel') {
  return getConcepts(envId).length > 0;
}

/** Kit sound names used to fill example snippets (with sensible placeholders). */
export function conceptNames(kit) {
  const names = (kit || []).map((k) => k.name).filter(Boolean);
  return {
    a: names[0] || 'sound1',
    b: names[1] || names[0] || 'sound2',
    c: names[2] || names[0] || 'sound3',
  };
}

/** Concepts grouped by category, preserving declaration order. */
export function conceptsByCategory(envId = 'strudel') {
  const out = [];
  const index = new Map();
  for (const c of getConcepts(envId)) {
    if (!index.has(c.category)) {
      const group = { category: c.category, items: [] };
      index.set(c.category, group);
      out.push(group);
    }
    index.get(c.category).items.push(c);
  }
  return out;
}

/** Transforms that wrap a selection. `onlyQuick` limits to the selection-bar set. */
export function transforms(envId = 'strudel', onlyQuick = false) {
  return getConcepts(envId).filter((c) => c.apply && (!onlyQuick || c.quick));
}

/** Concepts detected in a piece of code — powers "explain this". */
export function explainConcepts(text, envId = 'strudel') {
  if (!text) return [];
  return getConcepts(envId).filter((c) => c.match && c.match.test(text));
}

/**
 * Compact, copyright-clean reference for an LLM — DERIVED from the same concept
 * library that drives the palette (so maintaining the palette maintains the AI's
 * knowledge). It is deliberately version-matched to the bundled Strudel: a model
 * shouldn't be told about functions the shipped version lacks, since those would
 * just error. Refresh at dependency-bump time, not continuously (docs/AI_EDIT_PLAN.md §6).
 *
 * Keep STRUDEL_REFERENCE_VERSION in sync with @strudel/repl in package.json.
 */
export const STRUDEL_REFERENCE_VERSION = '1.3';
// Keep in sync with @csound/browser in package.json (pinned exactly, on purpose).
export const CSOUND_REFERENCE_VERSION = '7.0.0-beta33';

// Core syntax the palette has no single concept for — hand-written, brief.
// Csound's is longer than Strudel's because more of it is non-obvious AND because
// most Csound material a model has seen is 6.x: `outs`, and opcodes this beta has
// moved. Stating the version's rules explicitly is cheaper than repairing them.
const CSOUND_PREAMBLE = `Csound 7 (WebAssembly build). Essentials:
- An ORCHESTRA defines instruments (instr N ... endin); a SCORE says when they play. Both live in ONE buffer here: everything above a line containing only <CsScore> is the orchestra, everything below it is the score.
- Do NOT write an \`sr\` line — the app sets the sample rate to match the browser. Start with: ksmps = 32 / nchnls = 2 / 0dbfs = 1.
- Output with \`out aL, aR\`. \`outs\` is DEPRECATED in Csound 7 — never emit it.
- A variable's first letter is its rate: a... = audio rate (the sound itself), k... = control rate (movement), i... = set once at note start, S... = string.
- p-fields come from the score line: p1 = instrument, p2 = start, p3 = duration, p4 onward are yours.
- \`schedule instr, whenFromNow, duration, p4...\` fires an event from code. Its start time is relative to NOW, so an instrument that schedules ITSELF one bar ahead is how you loop. A score on its own ends.
- Kit sounds are files in Csound's virtual filesystem, played with \`diskin2 "<path>", rate\`. They are MONO, so diskin2 takes ONE output. The available paths are listed under the prompt.
- Every kit sound is peak-normalised. Scale down when layering (e.g. * 0.35) or you will exceed 0dbfs and Csound will report samples out of range.
- COMMENT THE CODE YOU WRITE, generously: say what each line does and which number to change to hear something different. The person reading it is learning Csound from your output.`;

// Core syntax the palette has no single concept for — hand-written, brief.
const STRUDEL_PREAMBLE = `Strudel is a JavaScript live-coding language (TidalCycles in the browser). Essentials:
- Only the LAST top-level expression makes sound. Build ONE expression (use stack / arrange / cat), or prefix parallel parts with "$:".
- Sound comes from samples: s("name") plays a registered sample; the available names are listed under the prompt.
- Mini-notation lives inside the quotes: "a b c" = a sequence (one per step); "a*4" = repeat 4x; "~" = a rest; "<a b>" = one per cycle (alternate); "[a b]" = a group/subdivision; "a(3,8)" = a Euclidean rhythm; "{a b, c d e}" = polymeter.
- Chain transforms with dots: s("a*4").fast(2).lpf(800).room(.3).
- Pitch: note("c e g") or n("0 2 4").scale("C:minor"). Layer with stack(a, b); one pattern per cycle with cat(a, b); arrange sections over cycles with arrange([4, a], [4, b]).
- Signals modulate parameters: sine, saw, tri, perlin — e.g. .lpf(sine.range(300, 2000).slow(4)).`;

// LLM-only idioms: composite recipes the palette doesn't cover as single concepts.
// buildReference() appends these; the palette ignores them. Short + verified against
// the bundled Strudel (tonal 1.2.6). Own words, own examples.
const STRUDEL_IDIOMS = [
  'Arpeggio — index a chord over time with n + voicing (do NOT use .arp, it errors): n("0 1 2 3").chord("<C Am F G>").voicing()',
  'Scale run / melody: n("0 2 4 6 4 2").scale("C:minor")',
  'Chords as blocks (voiced), add struct for rhythm: chord("<C^7 Am7 Dm7 G7>").voicing().struct("x ~ x x")',
  'Chord + bassline from one chord pattern: chord("<C^7 Am7 Dm7 G7>").layer(x => x.struct("[~ x]*2").voicing(), x => x.rootNotes(2).note().s("sawtooth"))',
];

/**
 * A compact reference block for an LLM system prompt, built from the concept library.
 * @param {string} envId
 * @param {Array} kit  current kit entries (their names fill the examples)
 * @returns {string}
 */
const PREAMBLES = { strudel: STRUDEL_PREAMBLE, csound: CSOUND_PREAMBLE };
const VERSIONS = { strudel: STRUDEL_REFERENCE_VERSION, csound: CSOUND_REFERENCE_VERSION };
const LANG_LABELS = { strudel: 'Strudel', csound: 'Csound' };

export function buildReference(envId = 'strudel', kit = []) {
  // No concept library means no grounding. Returning a half-empty reference would
  // invite the model to fall back on whatever it remembers, which for Csound means
  // 6.x idioms this build rejects. Callers check hasConcepts() and don't ask.
  if (!hasConcepts(envId)) return '';
  const names = conceptNames(kit);
  const preamble = PREAMBLES[envId] || '';
  const version = VERSIONS[envId] || '';
  const label = LANG_LABELS[envId] || envId;
  const lines = [];
  for (const group of conceptsByCategory(envId)) {
    lines.push(`\n## ${group.category}`);
    for (const c of group.items) {
      const ex = c.example ? ` — e.g. \`${c.example(names).replace(/\n/g, ' ')}\`` : '';
      lines.push(`- ${c.label}: ${c.explain}${ex}`);
    }
  }
  const idioms = envId === 'strudel' && STRUDEL_IDIOMS.length
    ? '\n\n## Idioms (prefer these; do not invent functions):\n- ' + STRUDEL_IDIOMS.join('\n- ')
    : '';
  return [
    preamble,
    version ? `\nThis targets ${label} ~${version}; only use functions available in that version.` : '',
    '\nAvailable techniques (label: what it does — example):',
    lines.join('\n'),
    idioms,
  ].filter(Boolean).join('\n');
}
