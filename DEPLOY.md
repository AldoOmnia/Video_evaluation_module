# Deploy — Comer pilot at `comer.daedalusiq.com`

Target: a single always-on web service on Render that serves
`/login`, `/lab/`, `/api/*`, and `/query` from one origin, reachable
at `https://comer.daedalusiq.com`.

This document covers the **first-time** deploy. After it's live, every
push to the `platform-comer` branch auto-deploys (because
`autoDeploy: true` in `render.yaml`).

---

## 0. Prereqs

- A Render account that can see the `AldoOmnia/Video_evaluation_module` repo
- An Anthropic API key with access to `claude-sonnet-4-6` (or whatever
  is set in `render.yaml` → `ANTHROPIC_MODEL`)
- DNS access to `daedalusiq.com`
- ~10 minutes

---

## 1. Push the latest `platform-comer` branch

```bash
git checkout platform-comer
git push origin platform-comer
```

(Already done at the time of writing — sanity-check `git status`.)

---

## 2. Create the Render Blueprint

1. Open [Render Dashboard → Blueprints → New Blueprint Instance](https://dashboard.render.com/blueprints)
2. Connect the GitHub repo `AldoOmnia/Video_evaluation_module` if you
   haven't already
3. Select branch **`platform-comer`**
4. Render will detect `render.yaml` and propose **one service**:
   - Name: `comer-platform`
   - Type: Web Service
   - Runtime: Node
   - Plan: Starter ($7/mo, no cold starts)
5. Click **Apply**. Render will prompt for two secrets — paste them
   into the dashboard, NOT into `render.yaml`:
   - `ANTHROPIC_API_KEY` — the key you already use for the Rokid build
   - `GEMINI_API_KEY` — same key as the glasses backend; powers the Brain
     dock's component-photo recognition (`gemini-3.5-flash`, the exact VLM
     the glasses observe loop runs — override via `GEMINI_VLM_OBSERVE_MODEL`)
   - `AUTH_TOKEN_SECRET` — any 32+ char random string, e.g.:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```

The first build runs `npm install && npm run build`, then starts with
`npm start`. The build typically takes ~90 seconds.

---

## 3. Verify the temporary Render URL

Render assigns a temporary URL like `https://comer-platform.onrender.com`.
Once the build is green:

```bash
curl https://comer-platform.onrender.com/health
```

Expected response:

```json
{
  "ok": true,
  "stubMode": false,
  "procedure": "Pinion Guide Assembly",
  "steps": 12,
  "hardwareProfiles": 7,
  "strategies": 4,
  "cors": ["https://comer.daedalusiq.com", "https://comer-platform.onrender.com"],
  "nodeEnv": "production"
}
```

If `stubMode: true` you forgot to paste the Anthropic key — fix it in
the Render service's Environment tab and redeploy.

Open `https://comer-platform.onrender.com/login` and sign in with
`admin@comer.com` / `rockford123` to confirm the full flow works
before cutting DNS over.

---

## 4. Point `comer.daedalusiq.com` at the service

### 4a. In Render

1. Open the `comer-platform` service → **Settings → Custom Domains**
2. Add `comer.daedalusiq.com`
3. Render shows the CNAME target (typically the same
   `comer-platform.onrender.com` or a `*.onrender.com` apex). Copy it.

### 4b. In your DNS host for `daedalusiq.com`

Create a single record:

| Type  | Name (Host)         | Value (Target)                | TTL  |
|-------|---------------------|-------------------------------|------|
| CNAME | `comer`             | `<value from Render>`         | 300  |

DNS propagation usually takes 1–10 minutes. You can watch it with:

```bash
dig +short comer.daedalusiq.com
```

### 4c. Wait for Render's TLS

Render auto-issues a Let's Encrypt cert as soon as DNS resolves. The
Custom Domains page flips from "Pending" to "Verified" once that's
done — usually within ~2 minutes of DNS being live.

### 4d. Retiring the previous domain

The platform was previously served at `comer.theomnia.ai`. Render allows
several custom domains per service, so both hosts can answer at once and the
cutover needs no downtime: add the new domain, verify it, then remove the old
one whenever Comer has stopped using it. `ALLOWED_ORIGINS` lists both until
that happens, so CORS never depends on the two changes landing together.

Sessions do not carry over. The session lives in `localStorage`, which is
scoped per origin, so everyone signs in once on the new hostname — worth
telling Comer in advance so it doesn't read as a broken deploy.

---

## 5. Final smoke test

```bash
curl https://comer.daedalusiq.com/health
```

Then in a browser:

1. `https://comer.daedalusiq.com/login`
2. Sign in with `admin@comer.com` / `rockford123`
3. Generate a simulated session in the eval lab
4. Click **Run · LIVE LLM** and confirm a real Claude call comes back

If the lab footer says `llm: live` and the run completes with a real
verdict, you're done.

---

## 6. Rotating credentials / disabling demo creds

Before showing this to the actual client, do at least these two things:

1. **Remove the demo credentials hint** from `eval-lab/public/login.html`
   (the `.creds-hint` block). It's intentionally visible right now
   because the build is a placeholder.
2. **Replace the hardcoded credentials** in `backend/src/routes/auth.ts`.
   For real customer use, plumb in an actual identity provider
   (Auth0/Okta/Workforce) — there's a `TODO` block at the top of that
   file calling this out.

---

## 6b. Reshim analysis: why runs happen elsewhere

The reshim agent is Python, talks to the plant's SQL Server over ODBC, and
reads operator photos from SharePoint. The Render service is a Node runtime
with none of that and no network route to Fargo, so **"Run now" is disabled
there on purpose** — `GET /api/reshim/capabilities` probes the interpreter and
the dashboard explains itself rather than surfacing an `ImportError`.

Runs happen in the `reshim-daily` workflow, which needs a runner **inside the
plant network**: the SQL Server is `WARKFSQL002`, a bare hostname only Comer's
internal DNS resolves, so no GitHub-hosted runner can reach it however it is
configured. Its `schedule:` is disarmed for that reason and the workflow is
manual-dispatch only; re-arm the cron and `runs-on: self-hosted` together once
the DGX/Tailscale runner is registered. Because the dashboard reads runs off its
own disk, the workflow hands its output over at the end:

| Where | Name | Value |
|---|---|---|
| GitHub repo secrets | `RESHIM_INGEST_URL` | `https://comer.daedalusiq.com` |
| GitHub repo secrets | `RESHIM_INGEST_TOKEN` | any long random string |
| Render env var | `RESHIM_INGEST_TOKEN` | the same string |

Generate one with `openssl rand -hex 32`. Until both sides are set the publish
step is skipped and `POST /api/reshim/runs` returns 503 — the endpoint writes
to disk, so it stays closed rather than open when unconfigured.

Ingested runs live on the mounted disk at `RESHIM_RUN_ROOT`
(`/var/reshim/runs`), not in the checkout, so a deploy does not wipe the
history. Locally you can leave both unset; the page simply says no runs yet.

### Where runs are read from

The dashboard reads two roots and merges them by date:

| Root | Written by | Survives |
|---|---|---|
| `RESHIM_RUN_ROOT` (`/var/reshim/runs`) | the ingest endpoint | deploys, via the mounted disk |
| `shared/data/reshim-archive/` | committed to git by hand | anything — it is in the checkout |

`shared/data/reshim-runs/` is gitignored: it is scratch output from whichever
machine last ran the agent. A run worth keeping gets copied into
`shared/data/reshim-archive/<YYYY-MM-DD>/` and committed, after which every host
that checks the code out shows it — a fresh disk, a new client environment, a
local clone. The live root wins on a date present in both, so a real run
published by the workflow supersedes an archived copy of the same day.

Seeding skips any date that already holds a real run, from either root, so
sample figures cannot mask a genuine report.

### Selecting a run, and the operator photos

The table is the page's control: selecting a row re-renders the chips, the five
KPI cards, the variant alert and the photo gallery for that run. The newest run
is selected on load. The sparkline stays as it is — it is the series, not a
property of one run.

The photos come out of the run's own workbook, because that is the only place
they exist: the pipeline downscales each one, anchors it to its serial number's
row, and keeps no separate copy. So `GET /api/reshim/runs/:date/detail` parses
the xlsx and returns the rows with their photo ids, and
`GET /api/reshim/runs/:date/photos/:id` serves the bytes, cached immutably since
a given run's photo never changes. A small LRU keeps the last two runs parsed, so
a gallery costs one cheap inflate per thumbnail rather than a 20 MB re-parse.

Nothing new has to be published for this to work — it reads reports already in
the archive or on the disk, including the three historical ones.

Two things the reader is deliberately careful about:

- **Three report generations.** The archived runs differ in string storage
  (shared vs inline), anchor element (`oneCellAnchor`, `twoCellAnchor`,
  `xdr:twoCellAnchor`) and relationship form, and the oldest has 23 columns
  rather than 21. Columns are found by header name and namespaces are stripped
  before matching. `npx tsx tools/check-reshim-workbooks.mts` checks all three;
  run it after touching `reshim-xlsx.ts`.
- **"No photos" is not "cannot read".** A workbook it fails to parse reports the
  reason, and the dashboard says the format was not recognised rather than
  implying nobody photographed anything that day.

`Image_Count` in the report counts photos *matched*, which can exceed the photos
embedded: there are a fixed number of image columns, and one August serial number
matched 51 photos against 7 columns. A card in that position says "showing 7 of
51 matched" rather than quietly dropping the rest.

### Sample data

The dashboard ships **empty**. "Seed sample" writes 30 days of invented runs,
each badged `SAMPLE DATA` on screen and banner-marked on the first line of its
workbook; "Clear sample" removes exactly those and leaves real analyses alone.
Both are behind the platform login, because seeding can send mail.

Seeded figures are deterministic, so a demo shown twice tells the same story.
Nothing here touches the plant.

### Emailing from the dashboard

Sending is independent of running: the Render service cannot compute a report
but can perfectly well send one, so `capabilities` reports `canTrigger` and
`canEmail` separately and the two controls are disabled independently.

Set the Graph app-only credentials on the service — `MSAL_TENANT_ID`,
`MSAL_CLIENT_ID`, `MSAL_CLIENT_SECRET`, `MAIL_FROM`, `MAIL_REPLY_TO`,
`MAIL_RECIPIENTS` — the same values `tools/reshim/config.py` reads. The app
registration needs the **Mail.Send application** permission with admin consent.
Leave them unset and "Also email" greys out with the reason in its tooltip.

A sample send goes to the standing `MAIL_RECIPIENTS` list, subject-prefixed
`[SAMPLE]`, with a red banner as the first line of the body. Untick "Also email"
to seed silently.

#### Re-sending a report that already exists

The daily workflow emails its report as it finishes, so this is for the
exceptions: an archived run, or one whose send failed at the time.

```bash
curl -X POST https://comer.daedalusiq.com/api/reshim/runs/2026-09-18/email \
  -H "Authorization: Bearer $SESSION_TOKEN" -H 'Content-Type: application/json' \
  -d '{}'                                  # omit "to" for the standing list
```

It reads the run from whichever root holds it and attaches that run's own
workbook, so figures and attachment cannot be mismatched. The `[SAMPLE]` prefix
and banner follow the run's own mock flag rather than a parameter — a real run
cannot be dressed as a sample, or the reverse. Pass `{"to": ["you@..."]}` to
preview a real report on yourself before the customer sees it.

Deliberately not wired to a button: the send is irreversible and goes to the
customer, which is a poor fit for a control sitting next to "Clear sample".

---

## 7. Adding the next client (`acme.daedalusiq.com`, etc.)

The platform is intentionally branched per-client. For a new client:

1. `git checkout -b platform-acme platform-comer`
2. Replace the Comer-specific bits:
   - `eval-lab/public/assets/comer-logo.png` → the new client logo
   - The tenant map in `backend/src/routes/auth.ts` (`TENANTS["acme"]`)
   - The styling tokens in `eval-lab/public/login.html` (or extract to a
     small theme file if more than one client diverges)
   - The procedure/taxonomy YAMLs under `shared/`
3. Push, then repeat steps 2–5 of this doc with the new branch name,
   service name, and subdomain.

The architecture is one Render service per tenant. Crashes / quota
spikes / config rollouts stay isolated.

---

## Monitor deploys from Cursor (Render MCP)

To check deploy status, logs, and metrics without leaving the editor, wire
Render's MCP server into Cursor. See [`docs/render-mcp-setup.md`](./docs/render-mcp-setup.md).

Quick version:

1. Create an API key at https://dashboard.render.com/u/settings?add-api-key
2. Run `./scripts/setup-render-mcp.sh` and paste the key
3. Restart MCP in Cursor → Settings → MCP
4. In chat: `Set my Render workspace to <your workspace>` then `List deploys for comer-platform`

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Build fails with `TS7016` / `Cannot find name 'process'` | `NODE_ENV=production` skipped devDependencies (`@types/*`, `typescript`) | `render.yaml` uses `npm install --include=dev && npm run build` |
| Build fails with `ERR_MODULE_NOT_FOUND` | Imports in `shared/` missing `.js` suffix | grep for `from "\\./[^"]*[^js]"` under `shared/types/`; add `.js` |
| `/health` says `stubMode: true` in prod | `ANTHROPIC_API_KEY` not set | Set in Render → Environment, redeploy |
| `/health` returns 200 but `/lab/` 404 | Path resolution drift | Re-check `backend/src/paths.ts` finds `brain-eval-lab.html` (it walks up the tree) |
| CORS error in the browser console | Hitting the API from a host not in `ALLOWED_ORIGINS` | Add the host to the env var in Render |
| `Origin not allowed: http://localhost:PORT` while signing in locally | Only in an old build — loopback is now trusted on any port when `NODE_ENV` is not `production` | Restart the dev server; no env change needed |
| Custom domain stuck "Pending" | DNS not yet propagated | `dig +short comer.daedalusiq.com` — wait until it returns Render's CNAME target |
| TLS cert never issues | DNS pointed at the wrong target | Re-check the CNAME value vs. what Render shows in Custom Domains |

---

## Cost

- Render Starter: **$7/month** per tenant (always-on, 512MB RAM, shared CPU)
- DNS: included with `daedalusiq.com`
- Anthropic: pay-per-token (eval-lab calls are bounded by `maxTokens: 380`
  in `backend/src/routes/eval.ts` — a 50-event run is roughly $0.05)

Downgrading to Render Free (`plan: free` in `render.yaml`) drops cost to
$0 but introduces 30-second cold starts after 15 minutes of inactivity.
Fine for internal demos, not fine for live customer use.
