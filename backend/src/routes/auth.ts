/**
 * Sign-in for the Comer portal.
 *
 * The account is the same one the Emotiv portal uses, and it is not in
 * source. Set EMOTIV_AUTH_EMAIL and EMOTIV_AUTH_PASSWORD_HASH
 * (scrypt$N$r$p$salt$hash, base64url). With either missing, login stays
 * closed. The token issued here is an HMAC over tenant+username+exp, stored
 * in localStorage and accepted by /api/auth/session.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { config } from "../config.js";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

interface Account {
  username: string;
  passwordHash: string;
  display: string;
  role: "admin";
}

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

/** One throwaway hash so a wrong email costs the same as a wrong password. */
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

export const authRouter = Router();

authRouter.post("/login", (req, res) => {
  const body = LoginBody.parse(req.body);
  if (body.tenant !== "comer") {
    res.status(401).json({ ok: false, error: "Invalid email or password" });
    return;
  }
  const account = comerAccount();
  if (!account) {
    res.status(503).json({ ok: false, error: "Sign-in is not configured" });
    return;
  }
  const user = account.username === body.username.trim().toLowerCase() ? account : null;
  let ok = false;
  try {
    ok = checkPassword(body.password, user ? user.passwordHash : DUMMY_HASH);
  } catch {
    ok = false;
  }
  if (!user || !ok) {
    res.status(401).json({ ok: false, error: "Invalid email or password" });
    return;
  }
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload = `comer|${user.username}|${exp}`;
  const sig = sign(payload);
  res.json({
    ok: true,
    token: `${payload}.${sig}`,
    ttlSec: TOKEN_TTL_SEC,
    user: { username: user.username, display: user.display, role: user.role },
    tenant: { id: "comer", label: "Comer Industries" },
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

/**
 * Require a valid login token on a route, read from `Authorization: Bearer …`.
 *
 * Most routes here are reads and stay open, gated only by the client-side
 * session check. Use this on anything that mutates state or spends something —
 * sending mail to the customer's distribution list, deleting runs — where
 * "the UI wouldn't let you" is not an access control.
 */
export function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const parsed = verify(token);
  if (!parsed) {
    res.status(401).json({ ok: false, error: "sign in again to do that" });
    return;
  }
  next();
}

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

function comerAccount(): Account | null {
  const username = (process.env.EMOTIV_AUTH_EMAIL || "").trim().toLowerCase();
  const passwordHash = (process.env.EMOTIV_AUTH_PASSWORD_HASH || "").trim();
  if (!username || !passwordHash || !hashLooksValid(passwordHash)) return null;
  const display = (process.env.EMOTIV_AUTH_NAME || "").trim() || username;
  return { username, passwordHash, display, role: "admin" };
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function hashLooksValid(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  return Number.isInteger(N) && N > 1 && Number.isInteger(r) && r > 0 && Number.isInteger(p) && p > 0;
}

function checkPassword(password: string, stored: string): boolean {
  if (!hashLooksValid(stored)) return false;
  const parts = stored.split("$");
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// `config` is intentionally imported to keep this module wired to the
// shared backend config bag even if no fields are referenced yet — future
// env-driven tenant config will land here.
void config;
