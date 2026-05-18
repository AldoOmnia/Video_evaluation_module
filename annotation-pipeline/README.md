# Annotation Pipeline (scaffold)

Placeholder for Priority 5 in `CURSOR-HANDOFF.md`. When real Comer footage
arrives, this becomes:

- A backend service that accepts uploaded videos (presumably from
  `glasses-app` or directly from QA)
- SAM2 mask propagation for object tracking (or YOLOv11 + label
  propagation per Budvytis)
- Whisper transcription for worker voice
- An exporter that emits `SessionEvent[]` JSON conforming to
  `shared/types/events.ts`

Until then, the eval lab uses the in-browser simulated session generator
in `eval-lab/src/sessionGen.ts`, and the manual VideoSegment tagging in
`brain-eval-lab.html` covers the small-scale labeling case.

## Suggested folder layout once we start

```
annotation-pipeline/
  src/
    sam2-propagator.ts
    whisper-transcriber.ts
    session-exporter.ts        # → SessionEvent[] (validated by Zod)
    review-ui/                 # next/vite app for low-confidence flags
  workers/
    track-objects.py           # heavy CV stays in Python
    transcribe.py
  data/
    raw/                       # uploaded video, ignored by git
    labeled/                   # exported JSON (the eval consumes these)
```

The output JSON format is already nailed down — see
`shared/types/events.ts` and the example payload in
`CURSOR-HANDOFF.md` §"Reference: data the eval produces."
