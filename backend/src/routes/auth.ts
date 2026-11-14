/**
 * Sign-in for the Emotiv portal.
 *
 * The account is not in source. Set EMOTIV_AUTH_EMAIL and
 * EMOTIV_AUTH_PASSWORD_HASH (scrypt$N$r$p$salt$hash, base64url). With either
 * missing, login stays closed. A successful login sets an HttpOnly cookie;
 * server.ts refuses pages, recordings, and API calls that do not carry it.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { config } from "../config.js";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

export const SESSION_COOKIE = "omnia_session";
const TOKEN_TTL_SEC = 60 * 60 * 8;

/** Long-lived secret used to sign tokens. Dev boots without one; production sets AUTH_TOKEN_SECRET. */
const TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || randomBytes(32).toString("hex");

interface Account {
  username: string;
  passwordHash: string;
  display: string;
  role: "admin";
}

export interface SessionClaims {
  tenant: string;
  username: string;
  exp: number;
}

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
  if (body.tenant !== "emotiv") {
    res.status(401).json({ ok: false, error: "Invalid email or password" });
    return;
  }
  const account = emotivAccount();
  if (!account) {
    res.status(503).json({ ok: false, error: "Sign-in is not configured" });
    return;
  }
  const user =
    account.username === body.username.trim().toLowerCase() ? account : null;
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
  const payload = `emotiv|${user.username}|${exp}`;
  const token = `${payload}.${sign(payload)}`;
  setSessionCookie(res, token);
  res.json({
    ok: true,
    token,
    ttlSec: TOKEN_TTL_SEC,
    user: { username: user.username, display: user.display, role: user.role },
    tenant: { id: "emotiv", label: "Emotiv" },
  });
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/session", (req, res) => {
  const token = (req.query.token as string) || "";
  const parsed = verify(token);
  if (!parsed) {
    res.status(401).json({ ok: false, error: "Invalid or expired token" });
    return;
  }
  res.json({
    ok: true,
    tenant: parsed.tenant,
    username: parsed.username,
    exp: parsed.exp,
  });
});

/** Bearer token or the session cookie. Either is enough. */
export function readSession(req: Request): SessionClaims | null {
  try {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
    const token = bearer || cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    return verify(token);
  } catch {
    return null;
  }
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!readSession(req)) {
    res.status(401).json({ ok: false, error: "Sign in required" });
    return;
  }
  next();
}

function emotivAccount(): Account | null {
  const username = (process.env.EMOTIV_AUTH_EMAIL || "").trim().toLowerCase();
  const passwordHash = (process.env.EMOTIV_AUTH_PASSWORD_HASH || "").trim();
  if (!username || !passwordHash || !hashLooksValid(passwordHash)) return null;
  const display = (process.env.EMOTIV_AUTH_NAME || "").trim() || username;
  return { username, passwordHash, display, role: "admin" };
}

export function hashPassword(password: string): string {
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

function setSessionCookie(res: Response, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(TOKEN_TTL_SEC)}`,
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieFlags(0)}`);
}

function cookieFlags(maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function cookieValue(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function sign(payload: string): string {
  return createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
}

function verify(token: string): SessionClaims | null {
  if (!token || !token.includes(".")) return null;
  const dot = token.lastIndexOf(".");
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;
  const [tenant, username, expStr] = payload.split("|");
  const exp = Number(expStr);
  if (!tenant || !username || !exp) return null;
  if (exp * 1000 < Date.now()) return null;
  return { tenant, username, exp };
}

void config;
