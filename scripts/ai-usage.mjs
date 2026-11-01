// Aggregates token usage of Claude Code, Codex and Cursor into data/ai-usage.json
// and renders images/ai-usage.svg. Only per-day token counts are stored, never prompts.
//
// Usage: node scripts/ai-usage.mjs [--year 2026] [--cursor-user <handle>]
// The Cursor handle defaults to CURSOR_USER from .env (untracked, see .env.example).
//
// Claude Code and Codex are read from their local logs, Cursor from the public profile page.
// Codex is replaced by the ChatGPT profile totals when data/chatgpt-import.json exists (see scripts/README.md).
// Counts include cache reads, matching what cursor.com/@<user> shows.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const dataFile = path.join(root, "data", "ai-usage.json");
const svgFile = path.join(root, "images", "ai-usage.svg");

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const year = Number(arg("year") ?? new Date().getFullYear());

// Profile handles live in the untracked .env file (see .env.example), never in the repo.
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
}
const cursorUser = arg("cursor-user") ?? process.env.CURSOR_USER;

const TOOLS = [
  { id: "claude", label: "Claude Code", color: "#d97757" },
  { id: "codex", label: "Codex (ChatGPT)", color: "#10a37f" },
  { id: "cursor", label: "Cursor", color: "#f54e00" },
];

function* jsonlFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(file);
    else if (/\.jsonl(\.zst)?$/.test(entry.name)) yield file;
  }
}

function readLines(file) {
  let buf = fs.readFileSync(file);
  if (file.endsWith(".zst")) buf = zlib.zstdDecompressSync(buf);
  return buf.toString("utf8").split("\n");
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

// day -> { tokens, cacheRead }
const collected = { claude: {}, codex: {}, cursor: {} };
function add(tool, day, tokens, cacheRead) {
  if (!day.startsWith(`${year}-`)) return;
  const entry = (collected[tool][day] ??= { tokens: 0, cacheRead: 0 });
  entry.tokens += tokens;
  entry.cacheRead += cacheRead;
}

function collectClaude() {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
  // Streaming writes the same message several times, so keep the last entry per message id.
  const messages = new Map();
  for (const file of jsonlFiles(dir)) {
    for (const line of readLines(file)) {
      if (!line.includes('"usage"')) continue;
      const entry = parse(line);
      const usage = entry?.message?.usage;
      if (!usage || !entry.timestamp) continue;
      messages.set(entry.message.id ?? entry.uuid, { day: entry.timestamp.slice(0, 10), usage });
    }
  }
  for (const { day, usage } of messages.values()) {
    const tokens =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    add("claude", day, tokens, usage.cache_read_input_tokens ?? 0);
  }
}

function collectCodex() {
  const base = path.join(os.homedir(), ".codex");
  const seen = new Set();
  for (const file of [...jsonlFiles(path.join(base, "sessions")), ...jsonlFiles(path.join(base, "archived_sessions"))]) {
    const session = path.basename(file).replace(/\.zst$/, "");
    if (seen.has(session)) continue;
    seen.add(session);
    // total_token_usage is cumulative per session, so attribute only the delta to each event's day.
    // Subagent sessions start with their parent's cumulative total, so the baseline is the first
    // total minus its own last_token_usage (zero for ordinary sessions).
    const split = (usage) => {
      const cached = usage.cached_input_tokens ?? 0;
      return { fresh: (usage.input_tokens ?? 0) - cached + (usage.output_tokens ?? 0), cached };
    };
    let prev = null;
    for (const line of readLines(file)) {
      if (!line.includes("token_count")) continue;
      const entry = parse(line);
      const info = entry?.payload?.info;
      if (!info?.total_token_usage || !entry.timestamp) continue;
      const current = split(info.total_token_usage);
      if (!prev) {
        const last = split(info.last_token_usage ?? info.total_token_usage);
        prev = { fresh: current.fresh - last.fresh, cached: current.cached - last.cached };
      }
      add("codex", entry.timestamp.slice(0, 10), current.fresh - prev.fresh, current.cached - prev.cached);
      prev = current;
    }
  }
}

// Cursor keeps no token counts locally, but the public profile embeds the daily totals.
async function collectCursor() {
  if (!cursorUser) {
    console.warn("Cursor skipped: set CURSOR_USER in .env or pass --cursor-user.");
    return false;
  }
  try {
    const res = await fetch(`https://cursor.com/@${cursorUser}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = (await res.text()).replaceAll('\\"', '"');
    const days = [...html.matchAll(/\{"date":"(\d{4}-\d\d-\d\d)","count":(\d+)\}/g)];
    if (days.length === 0) throw new Error("no activityCounts found, page layout may have changed");
    for (const [, day, count] of days) add("cursor", day, Number(count), 0);
    return true;
  } catch (error) {
    console.warn(`Cursor profile not updated: ${error.message}`);
    return false;
  }
}

collectClaude();
collectCodex();
const hasCursor = await collectCursor();

// Merge into the stored history so days survive after the tools rotate their local logs.
const stored = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : { days: {} };
for (const tool of TOOLS) {
  for (const [day, value] of Object.entries(collected[tool.id])) {
    const old = stored.days[tool.id]?.[day];
    if (!old || value.tokens + value.cacheRead >= old.tokens + old.cacheRead) {
      (stored.days[tool.id] ??= {})[day] = value;
    }
  }
}

// The ChatGPT profile covers all devices, so inside its date range it replaces the local Codex logs.
const chatgptFile = path.join(root, "data", "chatgpt-import.json");
if (fs.existsSync(chatgptFile)) {
  const imported = JSON.parse(fs.readFileSync(chatgptFile, "utf8"));
  const dates = Object.keys(imported).sort();
  const codex = (stored.days.codex ??= {});
  for (const day of Object.keys(codex)) {
    if (day >= dates[0] && day <= dates.at(-1)) delete codex[day];
  }
  for (const [day, tokens] of Object.entries(imported)) codex[day] = { tokens, cacheRead: 0 };
}
stored.updated = new Date().toISOString().slice(0, 10);
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
fs.writeFileSync(dataFile, JSON.stringify(stored, null, 1) + "\n");

// ---- one heatmap per tool, GitHub style: weeks as columns, Sunday first ----
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const fmt = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`;

function renderSvg() {
  const W = 820;
  const pitch = 13;
  const left = 56;
  const start = Date.UTC(year, 0, 1);
  const gridStart = start - new Date(start).getUTCDay() * DAY;
  const weeks = Math.ceil((Date.UTC(year, 11, 31) - gridStart) / DAY / 7) + 1;
  const blockH = 150;
  const H = 56 + TOOLS.length * blockH + 24;
  const months = "JFMAMJJASOND";
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="AI token usage ${year}">`,
    `<style>text{font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;fill:#a9b1d6}.t{font-size:18px;font-weight:600;fill:#70a5fd}.h{font-size:13px;font-weight:600;fill:#c0caf5}.s{font-size:11px}</style>`,
    `<rect width="${W}" height="${H}" rx="8" fill="#1a1b27"/>`,
    `<text class="t" x="24" y="34">AI Token Usage ${year}</text>`,
  ];
  TOOLS.forEach((tool, index) => {
    const days = Object.fromEntries(
      Object.entries(stored.days[tool.id] ?? {})
        .filter(([day]) => day.startsWith(`${year}-`))
        .map(([day, v]) => [day, v.tokens + v.cacheRead]),
    );
    const values = Object.values(days).filter((v) => v > 0).sort((a, b) => a - b);
    const total = values.reduce((s, v) => s + v, 0);
    // Four intensity levels from the quartiles of this tool's own active days.
    const bounds = [0.25, 0.5, 0.75].map((q) => values[Math.floor(q * (values.length - 1))] ?? 0);
    const level = (v) => (v <= 0 ? 0 : 1 + bounds.filter((b) => v > b).length);
    const opacity = [0, 0.3, 0.5, 0.75, 1];
    const y0 = 56 + index * blockH;
    const summary = values.length ? `${fmt(total)} tokens, ${values.length} active days` : "no data";
    out.push(`<text class="h" x="24" y="${y0}">${tool.label}</text>`, `<text class="s" x="${W - 24}" y="${y0}" text-anchor="end">${summary}</text>`);
    ["M", "W", "F"].forEach((label, i) => out.push(`<text class="s" x="${left - 12}" y="${y0 + 36 + (1 + i * 2) * pitch + 4}" text-anchor="end">${label}</text>`));
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const weekStart = gridStart + w * 7 * DAY;
      const month = new Date(weekStart + 3 * DAY).getUTCMonth();
      const inYear = new Date(weekStart + 3 * DAY).getUTCFullYear() === year;
      if (inYear && month !== lastMonth) {
        out.push(`<text class="s" x="${left + w * pitch}" y="${y0 + 24}">${months[month]}</text>`);
        lastMonth = month;
      }
      for (let d = 0; d < 7; d++) {
        const t = weekStart + d * DAY;
        if (t < start || new Date(t).getUTCFullYear() !== year) continue;
        const l = level(days[iso(t)] ?? 0);
        const cx = left + w * pitch + 5;
        const cy = y0 + 36 + d * pitch + 5;
        out.push(
          l === 0
            ? `<circle cx="${cx}" cy="${cy}" r="5" fill="#24283b"/>`
            : `<circle cx="${cx}" cy="${cy}" r="5" fill="${tool.color}" fill-opacity="${opacity[l]}"/>`,
        );
      }
    }
  });
  out.push(`<text class="s" x="24" y="${H - 12}" opacity="0.7">Tokens per day incl. cache reads, no prompts stored. Updated ${stored.updated}.</text>`, `</svg>`);
  return out.join("\n") + "\n";
}

fs.mkdirSync(path.dirname(svgFile), { recursive: true });
fs.writeFileSync(svgFile, renderSvg());

for (const tool of TOOLS) {
  const total = Object.entries(stored.days[tool.id] ?? {})
    .filter(([day]) => day.startsWith(`${year}-`))
    .reduce((s, [, v]) => s + v.tokens + v.cacheRead, 0);
  console.log(`${tool.label.padEnd(12)} ${year}: ${fmt(total)} tokens`);
}
