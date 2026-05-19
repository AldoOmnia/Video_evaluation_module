/**
 * Tenant-scoped login for the white-labelled enterprise platform.
 *
 * This branch is `platform-comer`, so the only tenant configured here is
 * `comer`. Other clients live on their own branches with their own
 * tenant config; the same shape is expected (id, label, users[]).
 *
 * Security note (placeholder build):
 *   - Credentials are bcrypt-less plain comparisons against a hardcoded
 *     map. ROTATE TO A REAL IDP (Auth0/Okta/Workforce) BEFORE PRODUCTION.
 *   - The token issued here is a simple HMAC over username+exp; it is
 *     stored in localStorage on the client and accepted by /api/auth/session.
 *   - There is no CSRF protection because we don't use cookies.
 *
 * The lab UI gates itself by checking localStorage.session.expiresAt; the
 * server can optionally verify the token via /api/auth/session if a route
 * ever moves to real session-based protection.
 */
import { Router } from "express";
import { z } from "zod";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { config } from "../config.js";

interface TenantUser {
  username: string;
  password: string;
  display: string;
  role: "operator" | "supervisor" | "admin";
}
interface Tenant {
  id: string;
  label: string;
  users: TenantUser[];
}

/** Per-branch tenant config. `platform-comer` only ships Comer. */
const TENANTS: Record<string, Tenant> = {
  comer: {
    id: "comer",
    label: "Comer Industries",
    users: [
      {
        username: "admin@comer.com",
        password: "rockford123",
        display: "Comer Admin",
        role: "admin",
      },
    ],
  },
};

/** Long-lived secret used to sign tokens. Falls back to a random per-boot
 *  secret so dev mode works without env config; production should set
 *  AUTH_TOKEN_SECRET. */
const TOKEN_SECRET =
  process.env.AUTH_TOKEN_SECRET || randomBytes(32).toString("hex");
const TOKEN_TTL_SEC = 60 * 60 * 8; // 8h

const LoginBody = z.object({
  tenant: z.string().min(1),
  username: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});

export const authRouter = Router();

authRouter.post("/login", (req, res) => {
  const body = LoginBody.parse(req.body);
  const tenant = TENANTS[body.tenant];
  if (!tenant) return res.status(401).json({ ok: false, error: "Unknown tenant" });
  const user = tenant.users.find(
    (u) => u.username.toLowerCase() === body.username.toLowerCase(),
  );
  // Constant-time-ish compare on the password regardless of user-found to
  // avoid a tiny username-enumeration timing oracle.
  const ok = user ? safeEq(user.password, body.password) : safeEq("x".repeat(8), body.password);
  if (!user || !ok) {
    return res.status(401).json({ ok: false, error: "Invalid email or password" });
  }
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload = `${tenant.id}|${user.username}|${exp}`;
  const sig = sign(payload);
  res.json({
    ok: true,
    token: `${payload}.${sig}`,
    ttlSec: TOKEN_TTL_SEC,
    user: { username: user.username, display: user.display, role: user.role },
    tenant: { id: tenant.id, label: tenant.label },
  });
});

authRouter.get("/session", (req, res) => {
  const token = (req.query.token as string) || "";
  const parsed = verify(token);
  if (!parsed) return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  res.json({
    ok: true,
    tenant: parsed.tenant,
    username: parsed.username,
    exp: parsed.exp,
  });
});

function sign(payload: string): string {
  return createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
}

function verify(
  token: string,
): { tenant: string; username: string; exp: number } | null {
  if (!token || !token.includes(".")) return null;
  const dot = token.lastIndexOf(".");
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  const [tenant, username, expStr] = payload.split("|");
  const exp = Number(expStr);
  if (!tenant || !username || !exp) return null;
  if (exp * 1000 < Date.now()) return null;
  return { tenant, username, exp };
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still touch both buffers to keep timing roughly constant.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// `config` is intentionally imported to keep this module wired to the
// shared backend config bag even if no fields are referenced yet — future
// env-driven tenant config will land here.
void config;
