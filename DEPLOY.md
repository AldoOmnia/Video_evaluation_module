# Deploy — Comer pilot at `comer.theomnia.ai`

Target: a single always-on web service on Render that serves
`/login`, `/lab/`, `/api/*`, and `/query` from one origin, reachable
at `https://comer.theomnia.ai`.

This document covers the **first-time** deploy. After it's live, every
push to the `platform-comer` branch auto-deploys (because
`autoDeploy: true` in `render.yaml`).

---

## 0. Prereqs

- A Render account that can see the `AldoOmnia/Video_evaluation_module` repo
- An Anthropic API key with access to `claude-sonnet-4-6` (or whatever
  is set in `render.yaml` → `ANTHROPIC_MODEL`)
- DNS access to `theomnia.ai`
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
  "cors": ["https://comer.theomnia.ai", "https://comer-platform.onrender.com"],
  "nodeEnv": "production"
}
```

If `stubMode: true` you forgot to paste the Anthropic key — fix it in
the Render service's Environment tab and redeploy.

Open `https://comer-platform.onrender.com/login` and sign in with
`admin@comer.com` / `rockford123` to confirm the full flow works
before cutting DNS over.

---

## 4. Point `comer.theomnia.ai` at the service

### 4a. In Render

1. Open the `comer-platform` service → **Settings → Custom Domains**
2. Add `comer.theomnia.ai`
3. Render shows the CNAME target (typically the same
   `comer-platform.onrender.com` or a `*.onrender.com` apex). Copy it.

### 4b. In your DNS host for `theomnia.ai`

Create a single record:

| Type  | Name (Host)         | Value (Target)                | TTL  |
|-------|---------------------|-------------------------------|------|
| CNAME | `comer`             | `<value from Render>`         | 300  |

DNS propagation usually takes 1–10 minutes. You can watch it with:

```bash
dig +short comer.theomnia.ai
```

### 4c. Wait for Render's TLS

Render auto-issues a Let's Encrypt cert as soon as DNS resolves. The
Custom Domains page flips from "Pending" to "Verified" once that's
done — usually within ~2 minutes of DNS being live.

---

## 5. Final smoke test

```bash
curl https://comer.theomnia.ai/health
```

Then in a browser:

1. `https://comer.theomnia.ai/login`
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

## 7. Adding the next client (`acme.theomnia.ai`, etc.)

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

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Build fails with `ERR_MODULE_NOT_FOUND` | Imports in `shared/` missing `.js` suffix | grep for `from "\\./[^"]*[^js]"` under `shared/types/`; add `.js` |
| `/health` says `stubMode: true` in prod | `ANTHROPIC_API_KEY` not set | Set in Render → Environment, redeploy |
| `/health` returns 200 but `/lab/` 404 | Path resolution drift | Re-check `backend/src/paths.ts` finds `brain-eval-lab.html` (it walks up the tree) |
| CORS error in the browser console | Hitting the API from a host not in `ALLOWED_ORIGINS` | Add the host to the env var in Render |
| Custom domain stuck "Pending" | DNS not yet propagated | `dig +short comer.theomnia.ai` — wait until it returns Render's CNAME target |
| TLS cert never issues | DNS pointed at the wrong target | Re-check the CNAME value vs. what Render shows in Custom Domains |

---

## Cost

- Render Starter: **$7/month** per tenant (always-on, 512MB RAM, shared CPU)
- DNS: included with `theomnia.ai`
- Anthropic: pay-per-token (eval-lab calls are bounded by `maxTokens: 380`
  in `backend/src/routes/eval.ts` — a 50-event run is roughly $0.05)

Downgrading to Render Free (`plan: free` in `render.yaml`) drops cost to
$0 but introduces 30-second cold starts after 15 minutes of inactivity.
Fine for internal demos, not fine for live customer use.
