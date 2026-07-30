# Sample-map manifest — format & rollout

This is the "owned, versioned artefact" from the platform task list (§ Sample-map
endpoint + livecoding integration, Tier 1). Environments consume it through thin
adapters; no app is the product, the manifest is.

## v0 reality (what this app does today)

For personal exploration the app **builds the map client-side** and needs **no new
backend endpoint**. It lists sounds via the existing community-graph API, then points
Strudel at each sound's already-public preview WAV:

    <recommend>/api/audio-previews/file/<soundId>.wav

That route already sends `Access-Control-Allow-Origin: *`,
`Cross-Origin-Resource-Policy: cross-origin`, and `Cache-Control: immutable`, which is
exactly what Strudel's `samples()` (an unauthenticated `fetch`) needs. So the "no auth
header possible" tension in the task doc does not bite the exploratory path, and neither
does metering (preview WAVs are already served freely; metering was only ever about the
VI *re-render* path).

At play time the app prepends:

    await samples({ "kick_evolved": "https://…/<id>.wav", "pad_warm": "https://…/<id2>.wav" })

and the names become usable as `s("kick_evolved")`, `note("c e g").s("pad_warm")`, etc.

## v1 manifest format (the artefact to serve later)

A JSON document, directly ingestible by Strudel's `samples()` (object form), with a
sidecar `_meta` that Strudel ignores but our tools and provenance use:

```jsonc
{
  "_meta": {
    "manifestVersion": 1,
    "kind": "pack",                 // "pack" (curated/public) | "garden" (personal)
    "id": "founders-01",
    "generatedAt": "2026-07-21T12:00:00Z",
    "licence": "CC-BY-4.0",
    "provenance": "synth.is — evolved with kromosynth"
  },
  // Strudel-consumable body: name -> URL (or [URLs] for round-robin/multi-sample)
  "kick_evolved": "https://media.synth.is/preview/<soundId>.wav",
  "pad_warm":     "https://media.synth.is/preview/<soundId2>.wav",

  // Optional per-sample metadata, keyed under _samples so it stays out of Strudel's way
  "_samples": {
    "kick_evolved": { "soundId": "<ulid>", "descriptors": { "brightness": "bright" }, "lineageRef": "<runId>:<gid>" }
  }
}
```

Notes:
- Sample **names** must be Strudel-safe identifiers (`[a-z0-9_]`, not leading a digit).
  See `uniqueSampleName()` in `src/lib/api.js` for the slug rule this app uses.
- **Multi-sample / velocity layers** would use the array form
  (`"name": ["url_soft.wav", "url_loud.wav"]`) once the VI multisample render path feeds it.
  Preview WAVs are single one-shots — great for exploration, repitched by Strudel.

## v2 endpoints (deferred — curation & sharing layer)

Only worth building once there's external uptake (task doc's Tier-1 gate):

- `GET /api/samplemap/pack/:packId` — curated, immutable, versioned, CDN-cacheable,
  **free & unmetered**. Stable public URLs so shared snippets keep working forever.
- `GET /api/samplemap/garden/:gardenId` — personal dereference. If it ever serves
  *freshly rendered* audio (not existing preview WAVs) it becomes metered and needs
  signed/expiring capability URLs — which breaks reproducibility of shared snippets.
  That trade-off is exactly why the *free* tier is public packs, not time-limited gardens.

Keeping v0/v1 client-side means we can defer all of that until it's justified.
