import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";
const USER_AGENT = "pi-nan/0.1.0 (+https://github.com/snevadalabs/pi-nan)";
const WARNING_RATIO = 0.8;
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

function ratio(model) {
  const r = model.cap ? model.tokensUsed / model.cap : 0;
  return Number.isFinite(r) ? r : 0;
}

function mostConstrained(models) {
  return models.reduce((best, m) => (ratio(m) > ratio(best) ? m : best));
}

function humanCount(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
  return `${n}`;
}

function relativeTime(isoDate, now) {
  const diffMs = new Date(isoDate).getTime() - now.getTime();
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (!Number.isFinite(hours)) return "?";
  if (hours <= 0) return "0h";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function setQuotaStatus(ctx, model, now) {
  let theme;
  // try/catch is load-bearing: ui.theme is a getter that can throw before pi-web initTheme.
  try {
    theme = ctx?.ui?.theme;
    if (!theme?.fg) return;
  } catch {
    return;
  }
  if (!ctx?.ui?.setStatus) return;

  const r = ratio(model);
  const pct = Math.round(r * 100);
  const pctTone = r >= WARNING_RATIO ? "warning" : "text";
  const reset = model.periodEnd ? ` · reset ${relativeTime(model.periodEnd, now)}` : "";

  const text =
    theme.fg("muted", "nan: ") +
    theme.fg("text", model.model + " ") +
    theme.fg(pctTone, `${pct}%`) +
    theme.fg("muted", reset);

  ctx.ui.setStatus("nan", text);
}

function warnOverQuota(ctx, models, warned) {
  for (const model of models) {
    const r = ratio(model);
    if (r < WARNING_RATIO) continue;
    const warnKey = `${model.model}:${model.periodEnd}`;
    if (warned.has(warnKey)) continue;
    warned.add(warnKey);
    const pct = Math.round(r * 100);
    ctx?.ui?.notify?.(`pi-nan: ${model.model} at ${pct}% of quota`, "warning");
  }
}

export default function nanExtension(pi, { fetchImpl = fetch, readKey = defaultReadKey, now = () => new Date() } = {}) {
  let lastAttemptAt = -Infinity;
  let notifiedNoKey = false;
  const warned = new Set();

  async function fetchQuota(key) {
    const response = await fetchImpl(QUOTA_URL, {
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

    let quota;
    try {
      quota = await fetchQuota(key);
    } catch {
      return;
    }

    if (!quota?.models?.length) return;

    setQuotaStatus(ctx, mostConstrained(quota.models), now());
    warnOverQuota(ctx, quota.models, warned);
  }

  async function showQuotaSummary(_args, ctx) {
    const key = (readKey() || "").trim();
    if (!key) {
      ctx?.ui?.notify?.(NO_KEY_MSG, "info");
      return;
    }

    let quota;
    try {
      quota = await fetchQuota(key);
    } catch {
      ctx?.ui?.notify?.("pi-nan: quota fetch failed", "error");
      return;
    }

    if (!quota?.models?.length) return;

    const lines = [...quota.models].sort((a, b) => ratio(b) - ratio(a)).map((m) => {
      const pct = Math.round(ratio(m) * 100);
      const reset = m.periodEnd ? ` · reset ${relativeTime(m.periodEnd, now())}` : "";
      return `${m.model}: ${humanCount(m.tokensUsed)}/${humanCount(m.cap)} (${pct}%)${reset}`;
    });

    ctx?.ui?.notify?.(lines.join("\n"), "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (now().getTime() - lastAttemptAt < REFRESH_THROTTLE_MS) return;
    await refreshStatus(ctx);
  });

  pi.registerCommand("nan", {
    description: "Show full NaN quota summary for all models",
    handler: showQuotaSummary,
  });
}
