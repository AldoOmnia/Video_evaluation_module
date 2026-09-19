# Design language

This platform is shown to plant directors, quality engineers and line managers,
often on a shared screen in a review meeting. It has to read like instrumentation
they can trust, not like a consumer app. The rules below apply to every surface
in this repo — the platform pages under `eval-lab/public/`, the reshim dashboard,
generated emails, and any CLI output a customer might see.

## 1. No emoji. None.

Do not put emoji or pictographic characters in user-facing copy, buttons, chips,
table cells, toasts, email bodies, or log lines a customer reads.

This is absolute. There is no "but it's just one, for warmth" exception, and no
"it's a status icon really" exception. Emoji render differently on every OS and
mail client, they turn colour in places the palette does not control, they carry
tone the product has not earned, and they are unreadable to anyone using a screen
reader at speed.

Banned, and the replacements to reach for instead:

| Instead of | Write |
|---|---|
| a spinner glyph | name the operation in a status line next to the affected value |
| a check mark before a status | the word: `emailed`, `passed`, `connected` |
| a cross mark before a status | the word: `failed`, `rejected` |
| a warning triangle | a weighted left border on the block, in the warn colour |
| a download arrow on a link | the format: `xlsx`, `csv`, `pdf` |
| a play triangle on a button | the verb alone: `Run now` |
| a sparkle to mean "AI" | nothing; the feature's name is enough |

What is still allowed, because it is typography rather than pictography:

- `·` as a separator, `—` as an em dash, `×` for dimensions or a close affordance
- `←` and `→` where they indicate direction of travel (`← Home`, `Station 130 → 135`)
- `%`, `≥`, `≤`, `±` in numeric copy
- Geometric Shapes (`U+25A0`–`U+25FF`) as monochrome icon glyphs — `◈ ◉ ▤ ◐ ◳ ◇ ◎`,
  as the sidebar already uses. These have no emoji presentation, so they render
  identically everywhere. Anything outside that block does not qualify, however
  geometric it looks: `⬡` and `✦` both sit in emoji blocks.

The test to apply: **would this character appear in a printed engineering
report?** An arrow and an em dash would. A wrapped gift would not.

Transport and media controls are **drawn, not typed** — a CSS triangle or an
inline SVG, never `▶`. See `#btnPlay` in `synthetic-pov.html` and `.twin-launch
.play` in `knowledge.html` for the two patterns.

### Enforcement

`npm run check:design` (also part of `npm run validate`) fails on emoji in the
customer-facing source, printing file, line, character and its name. Pass
`--all` to widen it to every tracked text file including developer tooling.

## 2. State goes next to the thing it describes

Progress and status belong beside the data they concern, not in the control that
started the work. A button says what it does; it should not also narrate what it
is doing.

The reshim dashboard is the reference implementation: while a run, seed, clear or
refresh is in flight, each KPI card's note line names the operation and a rule
sweeps the foot of the card. The button that started it only dims. When the work
finishes, the note lines go back to describing the numbers — `114 of 126`,
`5 excluded` — so the space is never decorative.

Every number that is a percentage or a rate should carry its count and
denominator underneath. A reader should not have to convert `7.9%` back into
units in their head.

## 3. Say why, not just no

A disabled control has to explain itself at the point of disablement. Probe the
server for the real reason and print it; never let a raw stack trace, an
`ImportError`, or a bare HTTP status reach the screen.

`GET /api/reshim/capabilities` is the pattern: it reports each ability
separately — `canTrigger` and `canEmail` are distinct, because a host can be able
to send a report while being unable to compute one — and returns a human sentence
for each that the UI shows in the control's tooltip and in a notice.

## 4. Sample data announces itself

Invented figures are never the default state of a customer-visible surface. When
they are present they must be unmistakable without anyone having to ask:

- a filled `SAMPLE DATA` chip in the page header, not an outlined one like every
  other chip
- `[SAMPLE]` at the front of any email subject, and a banner as the first line of
  the body
- a banner on the first row of any workbook
- one action that removes all of it, and that leaves real data untouched

## 5. Typography and colour

- Numbers, codes, station IDs, variant names and all technical labels use the
  mono face (`var(--mono)`, Space Grotesk). Prose uses Inter.
- Colour is carried by CSS custom properties only. No hardcoded hex in a
  component — light and dark mode both have to work, and a hex value only ever
  serves one of them.
- Severity has a fixed vocabulary: `--ok`, `--warn`, `--err`. Do not introduce a
  fourth shade to mean "sort of bad".
- Respect `prefers-reduced-motion`: any animation must degrade to a static state.
