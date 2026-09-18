"""SharePoint / OneDrive share polling via Microsoft Graph.

Two auth modes:
  - device-code (interactive; used for local dev + first-time setup)
  - client-credentials (unattended; used by the scheduled runner)

Downloads new items (by createdDateTime) from a share URL into a local dir.
"""
from __future__ import annotations
import base64
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

import msal
import requests

from .config import Config


GRAPH_ROOT = "https://graph.microsoft.com/v1.0"


def _encode_share_url(url: str) -> str:
    """Graph 'shares' API sharing token per docs."""
    b64 = base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")
    return "u!" + b64


def _acquire_token(cfg: Config, scopes: list[str], *, interactive: bool = False) -> str:
    """Get an access token, preferring silent → client-credentials → device-code."""
    authority = f"https://login.microsoftonline.com/{cfg.msal.tenant_id}"

    # If client secret present, use app-only client credentials (unattended)
    if cfg.msal.client_secret and not interactive:
        app = msal.ConfidentialClientApplication(
            cfg.msal.client_id, authority=authority, client_credential=cfg.msal.client_secret
        )
        # For client credentials the scope must be the resource + /.default
        cc_scopes = ["https://graph.microsoft.com/.default"]
        result = app.acquire_token_for_client(scopes=cc_scopes)
        if "access_token" in result:
            return result["access_token"]
        # Fall through to interactive if client-credentials failed

    # Delegated flow with token cache
    cache = msal.SerializableTokenCache()
    cache_file = Path("/tmp/reshim_msal_cache.bin")
    if cache_file.exists():
        cache.deserialize(cache_file.read_text())
    app = msal.PublicClientApplication(cfg.msal.client_id, authority=authority, token_cache=cache)
    accounts = app.get_accounts()
    result = None
    if accounts:
        result = app.acquire_token_silent(scopes, account=accounts[0])
    if not result:
        flow = app.initiate_device_flow(scopes=scopes)
        if "user_code" not in flow:
            raise RuntimeError(f"Device code init failed: {flow}")
        print("\n" + "=" * 60)
        print(flow["message"])
        print("=" * 60 + "\n", flush=True)
        result = app.acquire_token_by_device_flow(flow)
    if cache.has_state_changed:
        cache_file.write_text(cache.serialize())
    if "access_token" not in result:
        raise RuntimeError(f"Auth failed: {result}")
    return result["access_token"]


def _list_children(token: str, share_url: str) -> Iterator[dict]:
    enc = _encode_share_url(share_url)
    url = f"{GRAPH_ROOT}/shares/{enc}/driveItem/children?$top=200"
    while url:
        r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        r.raise_for_status()
        data = r.json()
        for item in data.get("value", []):
            yield item
        url = data.get("@odata.nextLink")


def _parse_created(item: dict) -> Optional[datetime]:
    raw = item.get("createdDateTime")
    if not raw:
        return None
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def poll_and_download(
    cfg: Config,
    dest_dir: Path,
    since: Optional[datetime] = None,
    *,
    interactive: bool = False,
) -> list[Path]:
    """Download items from the configured share URL created at/after `since`.

    Returns absolute paths of newly downloaded files (skips items already
    present with matching size).
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    token = _acquire_token(cfg, ["Files.Read.All"], interactive=interactive)
    downloaded: list[Path] = []
    for item in _list_children(token, cfg.msal.sharepoint_share_url):
        name = item.get("name")
        if not name:
            continue
        if since is not None:
            created = _parse_created(item)
            if created is None or created < since:
                continue
        size = item.get("size", 0)
        out = dest_dir / name
        if out.exists() and out.stat().st_size == size:
            continue
        durl = item.get("@microsoft.graph.downloadUrl")
        if not durl:
            continue
        r = requests.get(durl, stream=True, timeout=180)
        r.raise_for_status()
        with open(out, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 16):
                if chunk:
                    f.write(chunk)
        downloaded.append(out)
    return downloaded
