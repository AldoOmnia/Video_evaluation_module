# Scheduling the reshim daily agent

Two options — pick whichever fits your ops posture today.

## A) launchd (macOS) — pilot, runs on your Mac

Fires daily at 17:00 local time (End of Fargo first shift). Requires your Mac
to be awake + VPN'd to Comer's network at that hour.

```bash
# 1. Edit io.omnia.reshim.daily.plist — change WorkingDirectory to your clone path
# 2. Install
cp tools/reshim/scheduler/io.omnia.reshim.daily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/io.omnia.reshim.daily.plist
# 3. Verify
launchctl list | grep io.omnia.reshim.daily
tail -f /tmp/reshim_daily.stdout.log       # watch it fire tomorrow at 17:00
```

Uninstall: `launchctl unload ~/Library/LaunchAgents/io.omnia.reshim.daily.plist`

Test immediately without waiting for 17:00: `launchctl start io.omnia.reshim.daily`

## B) GitHub Actions cron — production, on DGX self-hosted runner

`.github/workflows/reshim-daily.yml` fires at 22:00 UTC daily. To move it off
the hosted `ubuntu-latest` runner (which cannot reach Comer's MSSQL) and onto
your DGX box:

1. Install the GH Actions runner on the DGX:
   `https://github.com/AldoOmnia/Video_evaluation_module/settings/actions/runners/new`

2. Register with a label like `dgx-vpn-comer`.

3. Edit the workflow: change `runs-on: ubuntu-latest` → `runs-on: [self-hosted, dgx-vpn-comer]`.

4. Populate GitHub Secrets: `MES_MSSQL_*`, `ANTHROPIC_API_KEY`, `MSAL_*`,
   `SHAREPOINT_SHARE_URL`, `MAIL_*`. The workflow materializes `backend/.env`
   from these on each run.

5. Test manually via **Actions → reshim-daily → Run workflow**.

## Environment expectations

Whichever runner executes the job needs:
- Reachability to `10.240.32.32:1433` (Comer MSSQL via VPN/Tailscale/on-plant)
- Reachability to `graph.microsoft.com` (SharePoint + sendMail)
- Reachability to `api.anthropic.com` (Claude Vision OCR)
- Python 3.12+ with the `tools/reshim/requirements.txt` deps installed
- `msodbcsql18` (or 17) system driver for pyodbc

## Timezone note

Comer plant is on `America/Chicago` (CDT ↔ CST). launchd fires on local Mac
wall clock (17:00 local); the GH Actions workflow uses UTC (22:00 UTC =
17:00 CDT / 16:00 CST). During November's CST switch the workflow fires one
hour before end-of-shift — acceptable given the plant is quiet by then.
