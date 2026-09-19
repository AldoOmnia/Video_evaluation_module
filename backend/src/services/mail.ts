/**
 * Outbound mail over Microsoft Graph, app-only.
 *
 * The Python agent (`tools/reshim/email_report.py`) owns the daily report mail
 * and will continue to, because it runs where the plant data is. This exists so
 * the dashboard can send from wherever it happens to be deployed — the cloud
 * host has no Python — and it deliberately reads the same environment contract
 * as `tools/reshim/config.py` so one set of secrets serves both.
 *
 * Client-credentials flow by hand rather than via @azure/msal-node: it is two
 * requests, and the dependency carries a browser-oriented cache abstraction
 * this has no use for.
 */
const TOKEN_HOST = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

function env(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

export interface MailCapability {
  canSend: boolean;
  reason: string | null;        // human-readable, shown in the UI when it cannot
  from: string | null;
  recipients: string[];         // the configured standing list
}

/** Split a comma-separated recipient list, tolerating stray whitespace. */
function configuredRecipients(): string[] {
  return (env("MAIL_RECIPIENTS") ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * Whether this host holds credentials to send at all. Cheap and synchronous —
 * it only inspects the environment, so the dashboard can ask on every load
 * without a round trip to Microsoft.
 */
export function mailCapability(): MailCapability {
  const from = env("MAIL_FROM");
  const recipients = configuredRecipients();
  const missing = (["MSAL_TENANT_ID", "MSAL_CLIENT_ID", "MSAL_CLIENT_SECRET"] as const).filter(
    (k) => !env(k),
  );

  if (missing.length > 0) {
    return {
      canSend: false,
      reason: `no Graph credentials on this host (${missing.join(", ")} unset)`,
      from,
      recipients,
    };
  }
  if (!from) {
    return { canSend: false, reason: "MAIL_FROM is unset", from, recipients };
  }
  if (recipients.length === 0) {
    return { canSend: false, reason: "MAIL_RECIPIENTS is unset", from, recipients };
  }
  return { canSend: true, reason: null, from, recipients };
}

/* ── Token ────────────────────────────────────────────────────────────── */

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  // Graph tokens last an hour; re-fetch a minute early rather than racing the
  // expiry and eating a 401 mid-send.
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const tenant = env("MSAL_TENANT_ID");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env("MSAL_CLIENT_ID") ?? "",
    client_secret: env("MSAL_CLIENT_SECRET") ?? "",
    scope: "https://graph.microsoft.com/.default",
  });

  const r = await fetch(`${TOKEN_HOST}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = (await r.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!r.ok || !j.access_token) {
    // error_description is the only field that says *why* (wrong secret, wrong
    // tenant, consent missing); the status alone is always 400.
    throw new Error(j.error_description?.split("\n")[0] ?? `token request failed (${r.status})`);
  }
  cached = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/* ── Send ─────────────────────────────────────────────────────────────── */

export interface Attachment {
  name: string;
  /** base64, as Graph wants it */
  contentBytes: string;
  contentType?: string;
}

export interface SendRequest {
  subject: string;
  html: string;
  to?: string[];               // defaults to MAIL_RECIPIENTS
  replyTo?: string;            // defaults to MAIL_REPLY_TO, else MAIL_FROM
  attachments?: Attachment[];
}

export interface SendResult {
  status: number;
  recipients: string[];
  subject: string;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function sendMail(req: SendRequest): Promise<SendResult> {
  const cap = mailCapability();
  if (!cap.canSend) throw new Error(cap.reason ?? "mail is not configured");

  const recipients = req.to && req.to.length > 0 ? req.to : cap.recipients;
  const replyTo = req.replyTo ?? env("MAIL_REPLY_TO") ?? cap.from!;

  const message = {
    subject: req.subject,
    body: { contentType: "HTML", content: req.html },
    toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
    replyTo: [{ emailAddress: { address: replyTo } }],
    attachments: (req.attachments ?? []).map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.contentType ?? XLSX_MIME,
      contentBytes: a.contentBytes,
    })),
  };

  const token = await accessToken();
  const r = await fetch(`${GRAPH}/users/${encodeURIComponent(cap.from!)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!r.ok) {
    // Graph puts the useful sentence in error.message; the body is otherwise
    // an opaque envelope with a request id.
    let detail = `${r.status}`;
    try {
      const j = (await r.json()) as { error?: { message?: string } };
      if (j.error?.message) detail = j.error.message;
    } catch {
      /* non-JSON error body: the status is all we get */
    }
    throw new Error(`Graph sendMail failed: ${detail}`);
  }

  return { status: r.status, recipients, subject: req.subject };
}
