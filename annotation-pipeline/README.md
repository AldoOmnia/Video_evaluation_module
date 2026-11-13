# Annotation Pipeline

First real slice: import the reviewed GlassKit cases from
`comer-rokid-demo/backend/eval` (`vision-eval`, PR #61) into the portal
contracts (`VideoSegment`, `SessionEvent`). SAM2 / Whisper stay deferred —
eleven minutes of footage does not need mask propagation.

## Why this exists

The web portal reports catch rate / false-positive rate and feeds
`POST /api/eval` so a prompt or model change can be scored without
re-wearing the glasses. It does **not** want embeddings. It wants:

| Artifact | Portal consumer |
| --- | --- |
| `video-index.csv` | Brain drop target → `VideoSegment` nodes (`ingestVideoIndex`) |
| `session-events.json` | Evaluate page / `POST /api/eval` |
| `/vision-cases/` | Dedicated review pane for the imported cases |

Those two files are produced on the glasses side:

```sh
# in comer-rokid-demo/backend  (branch vision-eval)
node eval/export-portal.mjs
```

Copy the result into `annotation-pipeline/data/incoming/` and re-import.

## Import (this repo)

```sh
npm run import:glasskit
```

That runs `src/from-glasskit.ts` against the incoming CSV/JSON, writes
validated `data/labeled/*.json`, and those files are what `/vision-cases/`
and `/lab/glasskit/` serve.

The importer is a Zod gate. A row that is not `step:NN`, or an
`errorType` outside the 19-code taxonomy, fails closed instead of
landing in the graph.

Then, in the lab (`npm run dev`):

1. Open **http://localhost:3001/vision-cases/** to review the imported cases.
2. Brain mode: drop `/lab/glasskit/video-index.csv` and the matching `Phase*_Video.MP4`.
3. Evaluate mode: **Import session from uploaded clips**.
4. Run sim or live LLM. That is the reporting loop.

## Still deferred

```
annotation-pipeline/
  src/
    from-glasskit.ts           # THIS FILE — GlassKit → portal
    sam2-propagator.ts         # later, at hundreds of hours of footage
    whisper-transcriber.ts
  data/
    incoming/                  # exporter output from comer-rokid-demo #61
    raw/                       # uploaded video, gitignored
    labeled/                   # validated JSON the eval consumes
```
