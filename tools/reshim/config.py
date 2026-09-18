"""Typed configuration loaded from backend/.env — shared with the TS backend."""
from __future__ import annotations
import os
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
_BACKEND_ENV = REPO_ROOT / "backend" / ".env"
_TOOL_ENV = Path(__file__).resolve().parent / ".env"

# Load .env files: backend/.env first (shared with TS), then tool-local override
if _BACKEND_ENV.exists():
    load_dotenv(_BACKEND_ENV)
if _TOOL_ENV.exists():
    load_dotenv(_TOOL_ENV, override=True)


def _env(key: str, default: Optional[str] = None) -> str:
    v = os.getenv(key, default)
    if v is None:
        raise RuntimeError(f"Required env var {key!r} not set (check backend/.env or tools/reshim/.env)")
    return v.strip()


def _env_optional(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key, "").strip()
    if not raw:
        return default
    return raw not in ("0", "false", "False", "no", "No")


@dataclass(frozen=True)
class MesConfig:
    host: str
    port: int
    database: str
    user: str
    password: str
    encrypt: bool
    trust_cert: bool

    def odbc_connstr(self) -> str:
        enc = "yes" if self.encrypt else "no"
        trust = "yes" if self.trust_cert else "no"
        return (
            "DRIVER={ODBC Driver 18 for SQL Server};"
            f"SERVER={self.host},{self.port};DATABASE={self.database};"
            f"UID={self.user};PWD={self.password};"
            f"Encrypt={enc};TrustServerCertificate={trust};"
        )


@dataclass(frozen=True)
class AnthropicConfig:
    api_key: str
    model: str


@dataclass(frozen=True)
class MsalConfig:
    tenant_id: str
    client_id: str
    client_secret: str
    sharepoint_share_url: str


@dataclass(frozen=True)
class MailConfig:
    from_addr: str
    reply_to: str
    recipients: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class RuntimeConfig:
    plant_tz: ZoneInfo
    run_dir: Path
    photo_stage_dir: Path
    ocr_cache_path: Path


@dataclass(frozen=True)
class Config:
    mes: MesConfig
    anthropic: AnthropicConfig
    msal: MsalConfig
    mail: MailConfig
    runtime: RuntimeConfig


def load_config() -> Config:
    plant_tz = ZoneInfo(_env_optional("MES_PLANT_TZ", "America/Chicago"))
    run_dir = Path(_env_optional("RESHIM_RUN_DIR", str(REPO_ROOT / "shared" / "data" / "reshim-runs"))).expanduser()
    photo_stage = Path(_env_optional("RESHIM_PHOTO_STAGE", "/tmp/reshim_photos")).expanduser()
    ocr_cache = Path(_env_optional("RESHIM_OCR_CACHE", "/tmp/reshim_ocr_cache.json")).expanduser()
    run_dir.mkdir(parents=True, exist_ok=True)
    photo_stage.mkdir(parents=True, exist_ok=True)

    return Config(
        mes=MesConfig(
            host=_env("MES_MSSQL_HOST"),
            port=int(_env_optional("MES_MSSQL_PORT", "1433")),
            database=_env_optional("MES_MSSQL_DATABASE", "SSL04_FARGO"),
            user=_env("MES_MSSQL_USER"),
            password=_env("MES_MSSQL_PASSWORD"),
            encrypt=_env_bool("MES_MSSQL_ENCRYPT", True),
            trust_cert=_env_bool("MES_MSSQL_TRUST_CERT", True),
        ),
        anthropic=AnthropicConfig(
            api_key=_env("ANTHROPIC_API_KEY"),
            model=_env_optional("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        ),
        msal=MsalConfig(
            tenant_id=_env("MSAL_TENANT_ID"),
            client_id=_env("MSAL_CLIENT_ID"),
            client_secret=_env_optional("MSAL_CLIENT_SECRET"),
            sharepoint_share_url=_env("SHAREPOINT_SHARE_URL"),
        ),
        mail=MailConfig(
            from_addr=_env_optional("MAIL_FROM", "aldo@daedalusiq.com"),
            reply_to=_env_optional("MAIL_REPLY_TO", "aldo@daedalusiq.com"),
            recipients=[r.strip() for r in _env_optional("MAIL_RECIPIENTS").split(",") if r.strip()],
        ),
        runtime=RuntimeConfig(
            plant_tz=plant_tz,
            run_dir=run_dir,
            photo_stage_dir=photo_stage,
            ocr_cache_path=ocr_cache,
        ),
    )


# -- Date helpers -----------------------------------------------------------

def plant_today(cfg: Config) -> date:
    return datetime.now(cfg.runtime.plant_tz).date()


def plant_day_bounds(cfg: Config, day: date) -> tuple[datetime, datetime]:
    """Return (start_of_day, next_day_start) in the plant timezone."""
    tz = cfg.runtime.plant_tz
    start = datetime.combine(day, time(0, 0), tzinfo=tz)
    return start, start + timedelta(days=1)


def run_dir_for(cfg: Config, day: date) -> Path:
    d = cfg.runtime.run_dir / day.isoformat()
    d.mkdir(parents=True, exist_ok=True)
    return d
