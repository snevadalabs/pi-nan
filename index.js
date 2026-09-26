import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_URL = "https://api.nan.builders/v1/usage";
const USER_AGENT = "pi-nan/0.1.0 (+https://github.com/snevadalabs/pi-nan)";
// ponytail: refresh cadence is hardcoded at 5 minutes; make it configurable if a use case needs a different one.
const REFRESH_THROTTLE_MS = 5 * 60 * 1000;
const KEY_FILE = join(homedir(), ".config", "nan", "api-key");
const NO_KEY_MSG = "pi-nan: no NaN API key found (set $NAN_API_KEY or ~/.config/nan/api-key)";

function defaultReadKey() {
  const envKey = (process.env.NAN_API_KEY || "").trim();
  if (envKey) return envKey;
  try {
    return readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function usageUrl(now) {
  const today = now().toISOString().slice(0, 10);
  return `${USAGE_URL}?start_date=${today.slice(0, 8)}01&end_date=${today}`;
}

function monthLabel(isoDate) {
  if (!isoDate) return "";
  // timeZone: UTC is load-bearing: a UTC midnight read in a negative offset lands in the previous month.
  return new Date(`${isoDate}T00:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" });
}

function humanCount(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
  return `${n}`;
}

function byModel(usage) {
  // totals.by_model covers the whole window; `data` is paginated, so never page through it.
  return usage?.totals?.by_model ?? [];
}

function mostUsed(models) {
  return models.reduce((best, m) => (m.total_tokens > best.total_tokens ? m : best));
}

// Month-to-date at the current rate. A rough pace, not a fact: the last day is partial.
function projection(tokens, usage) {
  const end = usage?.end_date;
  if (!end) return null;
  const day = Number(end.slice(8, 10));
  if (!day) return null;
  const daysInMonth = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).getUTCDate();
  return Math.round((tokens / day) * daysInMonth);
}

function tokenCount(tokens, usage) {
  const projected = projection(tokens, usage);
  return projected == null ? humanCount(tokens) : `${humanCount(tokens)} → ${humanCount(projected)}`;
}

function setUsageStatus(ctx, usage, model) {
  let theme;
  // try/catch is load-bearing: ui.theme is a getter that can throw before pi-web initTheme.
  try {
    theme = ctx?.ui?.theme;
    if (!theme?.fg) return;
  } catch {
    return;
  }
  if (!ctx?.ui?.setStatus) return;

  const month = monthLabel(usage?.start_date);
  const text =
    theme.fg("muted", "nan: ") +
    theme.fg("text", model.model + " ") +
    theme.fg("text", tokenCount(model.total_tokens, usage)) +
    theme.fg("muted", month ? ` · ${month}` : "");

  ctx.ui.setStatus("nan", text);
}

export default function nanExtension(pi, { fetchImpl = fetch, readKey = defaultReadKey, now = () => new Date() } = {}) {
  let lastAttemptAt = -Infinity;
  let notifiedNoKey = false;

  async function fetchUsage(key) {
    const response = await fetchImpl(usageUrl(now), {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT },
    });
    if (!response.ok) throw new Error();
    return response.json();
  }

  async function refreshStatus(ctx) {
    lastAttemptAt = now().getTime();
    const key = (readKey() || "").trim();
    if (!key) {
      if (!notifiedNoKey) {
        notifiedNoKey = true;
        ctx?.ui?.notify?.(NO_KEY_MSG, "info");
      }
      return;
    }

    let usage;
    try {
      usage = await fetchUsage(key);
    } catch {
      return;
    }

    const models = byModel(usage);
    if (!models.length) return;

    setUsageStatus(ctx, usage, mostUsed(models));
  }

  async function showUsageSummary(_args, ctx) {
    const key = (readKey() || "").trim();
    if (!key) {
      ctx?.ui?.notify?.(NO_KEY_MSG, "info");
      return;
    }

    let usage;
    try {
      usage = await fetchUsage(key);
    } catch {
      ctx?.ui?.notify?.("pi-nan: usage fetch failed", "error");
      return;
    }

    const models = byModel(usage);
    if (!models.length) return;

    const month = monthLabel(usage?.start_date);
    const lines = [...models]
      .sort((a, b) => b.total_tokens - a.total_tokens)
      .map((m) => `${m.model}: ${tokenCount(m.total_tokens, usage)} (${m.api_requests} req)`);
    lines.push(`all time: ${humanCount(usage.all_time?.total_tokens ?? 0)}`);

    ctx?.ui?.notify?.(`nan usage${month ? ` · ${month}` : ""}:\n${lines.join("\n")}`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (now().getTime() - lastAttemptAt < REFRESH_THROTTLE_MS) return;
    await refreshStatus(ctx);
  });

  pi.registerCommand("nan", {
    description: "Show NaN token usage for this month, per model",
    handler: showUsageSummary,
  });
}
