"""Typer CLI entrypoint for the reshim daily agent.

Usage examples:
  python -m tools.reshim run                          # analyze today's data
  python -m tools.reshim run --date 2026-09-17        # backfill a specific day
  python -m tools.reshim run --no-email               # skip email delivery
  python -m tools.reshim poll-photos                  # download new photos only
  python -m tools.reshim test-mssql                   # verify DB connection
"""
from __future__ import annotations
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import typer

from .config import load_config, plant_today, run_dir_for
from .pull import fetch_measurements, fetch_testno_lookup
from .analyze import classify_rows, summarize
from .sharepoint import poll_and_download
from .ocr import SnExtractor, photo_ts
from .match import PhotoRecord, assign
from .build_xlsx import build as build_xlsx
from .email_report import send_report


app = typer.Typer(help="Comer Fargo daily reshim analysis agent.")


def _parse_date(s: Optional[str], plant_tz) -> date:
    if s is None:
        return datetime.now(plant_tz).date()
    return date.fromisoformat(s)


@app.command()
def run(
    date_str: Optional[str] = typer.Option(None, "--date", help="Analysis day (YYYY-MM-DD; default: plant today)"),
    email: bool = typer.Option(True, help="Send email report after building xlsx"),
    poll: bool = typer.Option(True, help="Poll SharePoint for new photos first"),
    interactive_auth: bool = typer.Option(False, help="Use device-code flow for SP/Graph auth"),
):
    """Full daily pipeline: pull DB → poll photos → OCR → match → xlsx → email."""
    cfg = load_config()
    day = _parse_date(date_str, cfg.runtime.plant_tz)
    run_dir = run_dir_for(cfg, day)

    typer.echo(f"[reshim] Analysis day: {day.isoformat()}")
    typer.echo(f"[reshim] Run dir:      {run_dir}")

    # 1. DB pull
    typer.echo("[reshim] Pulling measurements from SSL04_FARGO…")
    measurements = fetch_measurements(cfg, day)
    testno = fetch_testno_lookup(cfg, day)
    typer.echo(f"[reshim]   {len(measurements)} rows measured, {len(testno)} test-number entries")

    # 2. Classify
    rows = classify_rows(measurements, testno)
    summary = summarize(rows)
    typer.echo(
        f"[reshim]   Classified: OK={summary.ok}  BAD={summary.bad}  BAD_HEAVY={summary.bad_heavy}  "
        f"(excluded {summary.excluded}, unknown_family {summary.unknown_family})"
    )
    (run_dir / "summary.json").write_text(json.dumps(summary.as_dict(), indent=2, default=str))
    (run_dir / "rows.json").write_text(json.dumps([r.as_dict() for r in rows], indent=2, default=str))

    # 3. Photos
    photos_dir = cfg.runtime.photo_stage_dir / day.isoformat()
    if poll:
        typer.echo("[reshim] Polling SharePoint for new photos…")
        # Look back 48h to catch late uploads for yesterday's work
        since = datetime.combine(day - timedelta(days=1), datetime.min.time()).replace(tzinfo=cfg.runtime.plant_tz)
        downloaded = poll_and_download(cfg, photos_dir, since=since, interactive=interactive_auth)
        typer.echo(f"[reshim]   Downloaded {len(downloaded)} new items to {photos_dir}")

    # 4. Inventory photos + OCR
    photo_paths = sorted([p for p in photos_dir.glob("*") if p.is_file() and not p.name.startswith(".")])
    photos: list[PhotoRecord] = []
    for p in photo_paths:
        ts = photo_ts(p)
        if ts:
            photos.append(PhotoRecord(path=p, ts=ts))
    typer.echo(f"[reshim] Photos with timestamps: {len(photos)}")

    valid_sns = {r.sn for r in rows}
    if photos and valid_sns:
        typer.echo("[reshim] Running SN OCR (Claude Vision)…")
        extractor = SnExtractor(cfg, valid_sns)
        results = extractor.extract_many(
            [p.path for p in photos],
            on_progress=lambda i, n: typer.echo(f"[reshim]   OCR {i}/{n}"),
        )
        ocr_map = {r.filename: r.sn for r in results}
        typer.echo(f"[reshim]   OCR anchors (SN found): {sum(1 for s in ocr_map.values() if s)}")
    else:
        ocr_map = {}

    # 5. Match photos → SNs
    assignments, unassigned, unknown_sn_photos = assign(photos, ocr_map, rows)
    typer.echo(f"[reshim] SNs with photos: {len(assignments)} / {len(rows)}")
    typer.echo(f"[reshim] Unassigned photos: {len(unassigned)}  |  photos of SNs not in DB: {len(unknown_sn_photos)}")

    # 6. Build xlsx
    xlsx_name = f"fargo_reshim_{day.strftime('%Y%m%d')}_with_images.xlsx"
    xlsx_path = run_dir / xlsx_name
    build_xlsx(rows, assignments, summary, xlsx_path,
               unmatched_photos=len(unassigned), unknown_sn_photos=len(unknown_sn_photos))
    typer.echo(f"[reshim] Workbook: {xlsx_path}  ({xlsx_path.stat().st_size/1024/1024:.1f} MB)")

    # 7. Email
    if email:
        sns_missing = [r.sn for r in rows if r.sn not in assignments or not assignments[r.sn].photos]
        typer.echo(f"[reshim] Sending email to {len(cfg.mail.recipients)} recipient(s)…")
        result = send_report(cfg, day, summary, xlsx_path, sns_missing, interactive=interactive_auth)
        (run_dir / "email.json").write_text(json.dumps(result, indent=2))
        typer.echo(f"[reshim]   → {result['status']}  {result['subject']}")
    else:
        typer.echo("[reshim] Email skipped (--no-email)")

    typer.echo(f"[reshim] Done.")


@app.command()
def poll_photos(
    date_str: Optional[str] = typer.Option(None, "--date"),
    interactive_auth: bool = typer.Option(True),
):
    """Download new photos from SharePoint into the day's staging folder."""
    cfg = load_config()
    day = _parse_date(date_str, cfg.runtime.plant_tz)
    dest = cfg.runtime.photo_stage_dir / day.isoformat()
    since = datetime.combine(day - timedelta(days=1), datetime.min.time()).replace(tzinfo=cfg.runtime.plant_tz)
    downloaded = poll_and_download(cfg, dest, since=since, interactive=interactive_auth)
    typer.echo(f"Downloaded {len(downloaded)} item(s) to {dest}")


@app.command()
def test_mssql():
    """Quick connectivity + row-count check against SSL04_FARGO."""
    cfg = load_config()
    import pyodbc
    with pyodbc.connect(cfg.mes.odbc_connstr(), timeout=10) as cx:
        cur = cx.cursor()
        cur.execute("SELECT @@SERVERNAME, @@VERSION")
        row = cur.fetchone()
        typer.echo(f"Connected: {row[0]}")
        cur.execute("SELECT COUNT(*) FROM SSL_ResPhase WHERE Phase_ID = '130_ReShim'")
        typer.echo(f"130_ReShim rows: {cur.fetchone()[0]}")


@app.command()
def test_email(
    to: Optional[str] = typer.Option(None, "--to", help="Extra recipients, comma-separated, on top of MAIL_RECIPIENTS"),
    date_str: Optional[str] = typer.Option(None, "--date", help="Nominal date to print in the test (default: plant today)"),
    interactive: bool = typer.Option(False, "--interactive", help="Interactive MSAL sign-in instead of app-only"),
):
    """Send a clearly-marked TEST report to verify mail delivery.

    Same Graph app-only path and attachment handling as the daily report, but
    the figures are invented and the subject and body say so. Safe to run
    against a real distribution list, though check who is on it first with
    `show-config`.
    """
    from .email_report import send_test_report

    cfg = load_config()
    day = date.fromisoformat(date_str) if date_str else plant_today(cfg)
    extra = [r.strip() for r in (to or "").split(",") if r.strip()]

    result = send_test_report(cfg, day, interactive=interactive, extra_recipients=extra)
    typer.echo(f"Sent {result['status']} — {result['subject']}")
    typer.echo(f"  to:         {', '.join(result['recipients'])}")
    typer.echo(f"  attachment: {result['attachment']} ({result['size_kb']} KB)")


@app.command()
def show_config():
    """Print resolved config (secrets masked)."""
    cfg = load_config()
    mask = lambda s: (s[:4] + "…" + s[-2:]) if len(s) > 8 else "***"
    typer.echo(f"MES:   {cfg.mes.user}@{cfg.mes.host}:{cfg.mes.port}/{cfg.mes.database}  pw={mask(cfg.mes.password)}")
    typer.echo(f"Anth:  model={cfg.anthropic.model}  key={mask(cfg.anthropic.api_key)}")
    typer.echo(f"MSAL:  tenant={cfg.msal.tenant_id}  client={cfg.msal.client_id}  secret={'yes' if cfg.msal.client_secret else 'no (interactive)'}")
    typer.echo(f"Mail:  from={cfg.mail.from_addr}  reply-to={cfg.mail.reply_to}")
    typer.echo(f"       recipients={cfg.mail.recipients}")
    typer.echo(f"TZ:    {cfg.runtime.plant_tz}   run_dir={cfg.runtime.run_dir}")


if __name__ == "__main__":
    app()
