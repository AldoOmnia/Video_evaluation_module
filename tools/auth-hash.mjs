#!/usr/bin/env node
/**
 * Hash a password for a sign-in account (EMOTIV_AUTH_PASSWORD_HASH, or the
 * "hash" of an entry in COMER_AUTH_USERS). Same parameters as
 * backend/src/routes/auth.ts.
 *
 *   npm run auth:hash               asks for the password, hidden
 *   npm run auth:hash -- --generate makes a password, prints it once with its hash
 *   echo -n 'secret' | node tools/auth-hash.mjs
 */
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

const N = 16384, R = 8, P = 1, KEYLEN = 32;
const hash = (password) => {
  const salt = randomBytes(16);
  const out = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${out.toString("base64url")}`;
};

async function readPassword() {
  if (!process.stdin.isTTY) {
    let all = "";
    for await (const chunk of process.stdin) all += chunk;
    return all.replace(/\r?\n$/, "");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Typed characters are not echoed.
  rl._writeToOutput = (text) => { if (text.includes("Password")) process.stderr.write(text); };
  const answer = await new Promise((resolve) => rl.question("Password: ", resolve));
  rl.close();
  process.stderr.write("\n");
  return answer;
}

if (process.argv.includes("--generate")) {
  // 18 characters from an alphabet without look-alikes (no 0/O, 1/l/I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let password = "";
  while (password.length < 18) {
    const b = randomBytes(1)[0];
    if (b < alphabet.length * 4) password += alphabet[b % alphabet.length];
  }
  console.log(JSON.stringify({ password, hash: hash(password) }));
} else {
  const password = await readPassword();
  if (password.length < 8) {
    console.error("a password of at least 8 characters is required");
    process.exit(1);
  }
  console.log(hash(password));
}
