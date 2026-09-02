import assert from "node:assert/strict";
import test from "node:test";

import nanExtension from "../index.js";

function createHarness(options) {
  const events = new Map();
  const pi = {
    on(eventName, handler) {
      events.set(eventName, handler);
    },
  };
  nanExtension(pi, options);
  return { events };
}

function createCtx() {
  const statuses = [];
  const notifications = [];
  return {
    statuses,
    notifications,
    ui: {
      setStatus(key, text) {
        statuses.push({ key, text });
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
      theme: {
        fg(_tone, str) {
          return str;
        },
      },
    },
  };
}

function quotaResponse(models, periodStart = "2026-08-01") {
  return { periodStart, models };
}

test("session_start with a key fetches quota and shows the most-constrained model", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      json: async () =>
        quotaResponse([
          { model: "glm", tokensUsed: 30, cap: 100, periodEnd: "2026-09-05T00:00:00Z" },
          { model: "qwen", tokensUsed: 90, cap: 100, periodEnd: "2026-09-05T00:00:00Z" },
        ]),
    };
  };

  const { events } = createHarness({
    fetchImpl,
    readKey: () => "secret-key",
    now: () => new Date("2026-09-02T00:00:00Z"),
  });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://cloud-api.nan.builders/api/usage/quota");
  assert.equal(fetchCalls[0].opts.headers.Authorization, "Bearer secret-key");
  assert.ok(fetchCalls[0].opts.headers["User-Agent"]);

  assert.equal(ctx.statuses.length, 1);
  assert.equal(ctx.statuses[0].key, "nan");
  assert.match(ctx.statuses[0].text, /qwen/);
  assert.match(ctx.statuses[0].text, /90%/);
  assert.match(ctx.statuses[0].text, /3d/);
  assert.equal(ctx.notifications.length, 0);
});

test("model at or above 80% is rendered with the warning color", async () => {
  let seenTone;
  const fetchImpl = async () => ({
    ok: true,
    json: async () =>
      quotaResponse([{ model: "glm", tokensUsed: 80, cap: 100, periodEnd: "2026-09-05T00:00:00Z" }]),
  });

  const { events } = createHarness({
    fetchImpl,
    readKey: () => "secret-key",
    now: () => new Date("2026-09-02T00:00:00Z"),
  });
  const ctx = createCtx();
  ctx.ui.theme.fg = (tone, str) => {
    if (tone === "warning") seenTone = tone;
    return str;
  };

  await events.get("session_start")({}, ctx);

  assert.equal(seenTone, "warning");
});

test("model below 80% does not use the warning color", async () => {
  let sawWarning = false;
  const fetchImpl = async () => ({
    ok: true,
    json: async () =>
      quotaResponse([{ model: "glm", tokensUsed: 10, cap: 100, periodEnd: "2026-09-05T00:00:00Z" }]),
  });

  const { events } = createHarness({
    fetchImpl,
    readKey: () => "secret-key",
    now: () => new Date("2026-09-02T00:00:00Z"),
  });
  const ctx = createCtx();
  ctx.ui.theme.fg = (tone, str) => {
    if (tone === "warning") sawWarning = true;
    return str;
  };

  await events.get("session_start")({}, ctx);

  assert.equal(sawWarning, false);
});

test("no key found: no status entry, exactly one startup notice", async () => {
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const { events } = createHarness({ fetchImpl, readKey: () => "" });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(ctx.statuses.length, 0);
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, "info");
  assert.match(ctx.notifications[0].message, /pi-nan/);
  assert.match(ctx.notifications[0].message, /NAN_API_KEY/);
});

test("fetch failure leaves status untouched and notifies nothing", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key" });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(ctx.statuses.length, 0);
  assert.equal(ctx.notifications.length, 0);
});

test("cap of 0 is treated as ratio 0 without throwing", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () =>
      quotaResponse([
        { model: "zero-cap", tokensUsed: 0, cap: 0, periodEnd: "2026-09-05T00:00:00Z" },
        { model: "glm", tokensUsed: 10, cap: 100, periodEnd: "2026-09-05T00:00:00Z" },
      ]),
  });

  const { events } = createHarness({
    fetchImpl,
    readKey: () => "secret-key",
    now: () => new Date("2026-09-02T00:00:00Z"),
  });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(ctx.statuses.length, 1);
  assert.match(ctx.statuses[0].text, /glm/);
});
