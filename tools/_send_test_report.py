"""Fire the reshim delivery self-test from this checkout.

`python -m tools.reshim test-email` is the real entry point, but importing the
CLI needs pyodbc, which needs the MSSQL driver, which this laptop has not got.
The email path itself has no such dependency, so call it directly.

Point RESHIM_CRED_ENV at a backend/.env holding the MSAL and MAIL values if this
checkout's own does not have them; it is loaded first, and config.py's
load_dotenv does not override what is already in the environment.

  .venv/bin/python tools/_send_test_report.py aldo@example.com
"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parents[1]
CRED_ENV = Path(os.environ.get("RESHIM_CRED_ENV", HERE / "backend" / ".env"))
if not CRED_ENV.exists():
    sys.exit(f"no credentials at {CRED_ENV} — set RESHIM_CRED_ENV")
load_dotenv(CRED_ENV)

sys.path.insert(0, str(HERE))

from tools.reshim.config import load_config, plant_today          # noqa: E402
from tools.reshim.email_report import send_test_report            # noqa: E402

cfg = load_config()
extra = [a for a in sys.argv[1:] if a]

print(f"from:       {cfg.mail.from_addr}")
print(f"reply-to:   {cfg.mail.reply_to}")
print(f"configured: {cfg.mail.recipients}")
print(f"extra:      {extra}")
print(f"app-only:   {'yes' if cfg.msal.client_secret else 'no (interactive)'}")
print()

result = send_test_report(cfg, plant_today(cfg), extra_recipients=extra)
print(f"sent {result['status']}")
print(f"  subject:    {result['subject']}")
print(f"  to:         {', '.join(result['recipients'])}")
print(f"  attachment: {result['attachment']} ({result['size_kb']} KB)")
