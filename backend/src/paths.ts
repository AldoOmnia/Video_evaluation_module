/**
 * Resolves repo-relative paths in a way that works identically across:
 *   - dev (tsx running `.ts` files at backend/src/...)
 *   - prod (compiled `.js` files at backend/dist/backend/src/...)
 *
 * We walk up the filesystem looking for a sentinel file that we know
 * only lives at the repo root (`brain-eval-lab.html`). This is more
 * robust than hard-coding a "..".."..".."."" offset that breaks the
 * moment the build layout changes.
 *
 * Compute once at import time; downstream modules just consume the
 * exported constants.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "brain-eval-lab.html"))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  // Last-ditch fallback — assume dev layout (backend/src/...).
  return join(start, "..", "..");
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = findRepoRoot(HERE);
export const SHARED_DIR = join(REPO_ROOT, "shared");
export const EVAL_LAB_PUBLIC = join(REPO_ROOT, "eval-lab", "public");
export const LAB_HTML = join(REPO_ROOT, "brain-eval-lab.html");
export const LOGIN_HTML = join(EVAL_LAB_PUBLIC, "login.html");
