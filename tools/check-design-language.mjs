/**
 * Fails on emoji in user-facing source. See DESIGN_LANGUAGE.md §1.
 *
 *   node tools/check-design-language.mjs            # the surfaces a customer sees
 *   node tools/check-design-language.mjs --all      # every tracked text file
 *
 * Typographic marks are deliberately not flagged: arrows, em dashes, the
 * multiplication sign and comparison operators all belong in an engineering
 * report. Pictographs do not.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/* Colour-by-default codepoints: the emoji blocks, Miscellaneous Symbols and
 * Dingbats, the variation selector that forces emoji presentation, and the few
 * strays outside those blocks that mail clients still colourise. */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{231A}\u{231B}\u{23E9}-\u{23FA}\u{25B6}\u{25C0}\u{2705}\u{274C}\u{2049}\u{203C}]/u;

const NAMES = {
  "⏳": "hourglass", "▶": "play triangle", "✓": "check mark", "✔": "check mark",
  "✗": "cross mark", "✘": "cross mark", "✕": "cross mark", "❌": "cross mark",
  "⚠": "warning sign", "⬇": "down arrow", "⬆": "up arrow", "✦": "sparkle",
  "✨": "sparkles", "⭐": "star", "🔴": "red circle", "🟢": "green circle",
  "❚": "block", "⬡": "hexagon", "⊘": "circled slash", "◐": "half circle",
};

/* The surfaces a customer actually reads. Tools and notebooks are excluded by
 * default — a check mark in a developer's terminal harms nobody. */
const DEFAULT_SCOPE = [
  "eval-lab/public",
  "backend/src",
  "shared",
];

const EXTS = new Set([".html", ".js", ".mjs", ".ts", ".css", ".json", ".md", ".py"]);
const SKIP = /node_modules|\/dist\/|\.min\.|package-lock|\.kb-store\.json|DESIGN_LANGUAGE\.md|check-design-language\.mjs/;

const all = process.argv.includes("--all");
const scope = all ? ["."] : DEFAULT_SCOPE;

const files = execFileSync("git", ["ls-files", ...scope], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => EXTS.has(f.slice(f.lastIndexOf("."))) && !SKIP.test(f));

let violations = 0;
const byFile = new Map();

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!EMOJI.test(text)) continue;

  text.split("\n").forEach((line, i) => {
    for (const ch of line) {
      if (!EMOJI.test(ch)) continue;
      violations++;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({
        line: i + 1,
        ch,
        name: NAMES[ch] ?? `U+${ch.codePointAt(0).toString(16).toUpperCase()}`,
        context: line.trim().slice(0, 78),
      });
    }
  });
}

if (violations === 0) {
  console.log(`design language: clean (${files.length} files checked)`);
  process.exit(0);
}

for (const [file, hits] of byFile) {
  console.log(`\n${file}`);
  for (const h of hits) {
    console.log(`  ${String(h.line).padStart(5)}  ${h.ch}  ${h.name}`);
    console.log(`         ${h.context}`);
  }
}
console.log(
  `\n${violations} emoji in ${byFile.size} file(s). DESIGN_LANGUAGE.md §1: use a word, ` +
  `a border weight, or a status line next to the value instead.`,
);
process.exit(1);
