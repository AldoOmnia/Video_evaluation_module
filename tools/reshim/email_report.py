"""Send daily reshim report via Microsoft Graph sendMail.

Reuses MSAL auth from sharepoint.py (Mail.Send scope). Plain-text body plus
xlsx attachment.
"""
from __future__ import annotations
import base64
from datetime import date
from pathlib import Path
from typing import Optional

import requests

from .analyze import ClassifiedSummary
from .config import Config
from .sharepoint import GRAPH_ROOT, _acquire_token


def _build_body(summary: ClassifiedSummary, day: date, sn_missing_photos: list[str]) -> str:
    included = summary.ok + summary.bad + summary.bad_heavy
    ok_pct = 100 * summary.ok / included if included else 0
    lines = [
        f"Comer Fargo — Reshim Daily Report",
        f"Analysis date: {day.isoformat()}",
        f"",
        f"— Summary —",
        f"  Total rows analyzed:  {summary.total}  (excluded: {summary.excluded})",
        f"  OK:                   {summary.ok}   ({ok_pct:.1f}%)",
        f"  BAD:                  {summary.bad}",
        f"  BAD_HEAVY:            {summary.bad_heavy}",
        f"  Unknown family:       {summary.unknown_family}",
        f"",
        f"— By Family —",
    ]
    for fam, cnt in sorted(summary.by_family.items()):
        total = sum(cnt.values())
        ok = cnt.get("OK", 0)
        pct = 100 * ok / total if total else 0
        lines.append(f"  Family {fam:<8}  n={total:<3}  OK={ok:<3}  BAD={cnt.get('BAD',0):<3}  BAD_HEAVY={cnt.get('BAD_HEAVY',0):<3}  ({pct:.1f}% OK)")
    lines.append("")
    if summary.high_bad_variants:
        lines.append("— Variants flagged (≥30% BAD) —")
        for v, n, p in summary.high_bad_variants:
            lines.append(f"  ⚠ {v:<24} n={n}  {p:.1f}% BAD")
        lines.append("")
    if sn_missing_photos:
        lines.append(f"— Missing photos ({len(sn_missing_photos)} SNs, review manually) —")
        for sn in sn_missing_photos[:20]:
            lines.append(f"  {sn}")
        if len(sn_missing_photos) > 20:
            lines.append(f"  … and {len(sn_missing_photos) - 20} more (see attachment)")
        lines.append("")
    lines.append("Full details in the attached workbook.")
    lines.append("")
    lines.append("— This report was generated automatically by the Omnia reshim agent.")
    lines.append("   Reply to this email to reach Aldo.")
    return "\n".join(lines)


def send_report(
    cfg: Config,
    day: date,
    summary: ClassifiedSummary,
    xlsx_path: Path,
    sn_missing_photos: list[str],
    *,
    interactive: bool = False,
    override_recipients: Optional[list[str]] = None,
) -> dict:
    recipients = override_recipients or cfg.mail.recipients
    if not recipients:
        raise RuntimeError("No mail recipients configured (MAIL_RECIPIENTS)")

    subject = f"Comer Fargo Reshim — {day.isoformat()} ({summary.ok + summary.bad + summary.bad_heavy} units, {int(100*summary.ok/max(summary.ok+summary.bad+summary.bad_heavy,1))}% OK)"
    body = _build_body(summary, day, sn_missing_photos)

    attachment_bytes = xlsx_path.read_bytes()
    attachment_b64 = base64.standard_b64encode(attachment_bytes).decode("ascii")

    message = {
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": [{"emailAddress": {"address": r}} for r in recipients],
            "replyTo": [{"emailAddress": {"address": cfg.mail.reply_to}}],
            "attachments": [{
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": xlsx_path.name,
                "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "contentBytes": attachment_b64,
            }],
        },
        "saveToSentItems": True,
    }

    # Mail.Send scope; note client-credentials also requires app-role granted in AAD
    token = _acquire_token(cfg, ["Mail.Send"], interactive=interactive)
    url = f"{GRAPH_ROOT}/users/{cfg.mail.from_addr}/sendMail"
    r = requests.post(url, json=message, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"Graph sendMail failed: {r.status_code} {r.text}")
    return {"status": r.status_code, "recipients": recipients, "subject": subject, "size_kb": len(attachment_bytes) // 1024}
