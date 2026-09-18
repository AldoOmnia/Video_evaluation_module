# reshim — Daily Reshim Analysis Agent

Automated daily analysis of Comer Industries reshim/backlash data from the
Fargo plant. Pulls same-day results from `SSL04_FARGO`, classifies each unit
against family-specific backlash spec, associates operator photos via OCR of
the SN label, and emails a summary + xlsx report to Comer stakeholders at
17:00 CT.

Run manually: `python -m tools.reshim run` (from repo root).

## Pipeline

```
17:00 CT  (launchd on Mac / GH Actions on DGX+Tailscale later)
   │
   ├─ pull.py         → MSSQL read: SSL_Res + SSL_ResPhase + SSL_ResPhase1
   │                    (stations 130/135 SHIMMING, Phase_ID='130_ReShim')
   │
   ├─ analyze.py      → Family lookup + OK/BAD/BAD_HEAVY classification
   │                    (see fargo-reshim-analysis memory playbook)
   │
   ├─ sharepoint.py   → Poll OneDrive share for new-since-yesterday photos
   │
   ├─ ocr.py          → Claude Vision extracts SN from each photo
   │                    (validates against DB SN list; recovers OCR misreads)
   │
   ├─ match.py        → Per-photo SN assignment + orphan-neighbor + time fallback
   │
   ├─ build_xlsx.py   → v2-layout workbook, images embedded via twoCellAnchor
   │
   └─ email_report.py → Graph API sendMail: plain-text summary + xlsx attached
```

## Environment (shares `backend/.env`)

```
MES_MSSQL_HOST=10.240.32.32           # Comer plant MSSQL (VPN required)
MES_MSSQL_PORT=1433
MES_MSSQL_DATABASE=SSL04_FARGO
MES_MSSQL_USER=sa
MES_MSSQL_PASSWORD=<secret>
MES_PLANT_TZ=America/Chicago

ANTHROPIC_API_KEY=<secret>            # Claude Vision for SN OCR
ANTHROPIC_MODEL=claude-sonnet-4-6     # override to opus for higher accuracy

MSAL_TENANT_ID=<daedalusiq tenant id>
MSAL_CLIENT_ID=<app registration id>
MSAL_CLIENT_SECRET=<secret>           # for unattended runs
SHAREPOINT_SHARE_URL=https://netorgft20895421-my.sharepoint.com/:f:/g/personal/...

MAIL_FROM=aldo@daedalusiq.com
MAIL_REPLY_TO=aldo@daedalusiq.com
MAIL_RECIPIENTS=alfonso.guidone@walterscheid.com,mattia_lugli@comerindustries.com,roberto_sironi@comerindustries.com,li_wen@comerindustries.com

RESHIM_RUN_DIR=./shared/data/reshim-runs
```

## Files

| File | Purpose |
|---|---|
| `config.py`      | Env → typed config; run directory + tz helpers |
| `pull.py`        | MSSQL query for same-day reshim rows (7-col schema) |
| `analyze.py`     | Family lookup, OK/BAD/BAD_HEAVY classification |
| `sharepoint.py`  | MSAL auth + Graph shares API + folder polling |
| `ocr.py`         | Claude Vision SN extraction (with ocrmac local fallback) |
| `match.py`       | Per-photo assignment (OCR direct → orphan neighbor → time fallback) |
| `build_xlsx.py`  | v2-layout workbook with embedded thumbnails |
| `email_report.py`| Graph sendMail with xlsx attachment |
| `cli.py`         | typer entrypoint: `run | backfill | test | dry-run` |

## Related

- [Backend MES service](../../backend/src/services/mesSql.ts) — TypeScript
  counterpart used by the eval-lab. Shares env vars.
- [Memory playbook](https://... redacted) — reshim classification rules,
  Family lookup, OCR method, known artifacts.
