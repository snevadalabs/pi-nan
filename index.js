import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";
const USER_AGENT = "pi-nan/0.1.0 (+https://github.com/snevadalabs/pi-nan)";
const WARNING_RATIO = 0.8;
const KEY_FILE = join(homedir(), ".config", "nan", "api-key");

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
  const warned = new Set();

  async function refreshStatus(ctx) {
    const key = (readKey() || "").trim();
    if (!key) {
      ctx?.ui?.notify?.("pi-nan: no NaN API key found (set $NAN_API_KEY or ~/.config/nan/api-key)", "info");
      return;
    }

    let quota;
    try {
      const response = await fetchImpl(QUOTA_URL, {
        headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT },
      });
      if (!response.ok) return;
      quota = await response.json();
    } catch {
      return;
    }

    if (!quota?.models?.length) return;

    setQuotaStatus(ctx, mostConstrained(quota.models), now());
    warnOverQuota(ctx, quota.models, warned);
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });
}
