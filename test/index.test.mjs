import assert from "node:assert/strict";
import test from "node:test";

import nanExtension from "../index.js";

function createHarness(options) {
  const events = new Map();
  const commands = new Map();
  const pi = {
    on(eventName, handler) {
      events.set(eventName, handler);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
  };
  nanExtension(pi, options);
  return { events, commands };
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
  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0].message, /qwen/);
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

test("model at or above 80% fires one warning notification naming it", async () => {
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

  await events.get("session_start")({}, ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, "warning");
  assert.match(ctx.notifications[0].message, /glm/);
  assert.match(ctx.notifications[0].message, /80%/);
});

test("a re-fetch in the same billing period does not re-warn", async () => {
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

  await events.get("session_start")({}, ctx);
  await events.get("session_start")({}, ctx);

  assert.equal(ctx.notifications.length, 1);
});

test("a new periodEnd re-arms the warning for that model", async () => {
  let periodEnd = "2026-09-05T00:00:00Z";
  const fetchImpl = async () => ({
    ok: true,
    json: async () =>
      quotaResponse([{ model: "glm", tokensUsed: 80, cap: 100, periodEnd }]),
  });

  const { events } = createHarness({
    fetchImpl,
    readKey: () => "secret-key",
    now: () => new Date("2026-09-02T00:00:00Z"),
  });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);
  periodEnd = "2026-10-05T00:00:00Z";
  await events.get("session_start")({}, ctx);

  assert.equal(ctx.notifications.length, 2);
});

test("a model that is not the most-constrained one also warns", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () =>
      quotaResponse([
        { model: "glm", tokensUsed: 95, cap: 100, periodEnd: "2026-09-05T00:00:00Z" },
        { model: "qwen", tokensUsed: 80, cap: 100, periodEnd: "2026-09-05T00:00:00Z" },
      ]),
  });

  const { events } = createHarness({
    fetchImpl,
    readKey: () => "secret-key",
    now: () => new Date("2026-09-02T00:00:00Z"),
  });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  const messages = ctx.notifications.map((n) => n.message);
  assert.ok(messages.some((m) => m.includes("glm")));
  assert.ok(messages.some((m) => m.includes("qwen")));
});

test("/nan command lists all models, most-constrained first, and bypasses the throttle", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return {
      ok: true,
      json: async () =>
        quotaResponse([
          { model: "glm", tokensUsed: 30_000, cap: 100_000, periodEnd: "2026-09-05T00:00:00Z" },
          { model: "qwen", tokensUsed: 483_000, cap: 2_000_000, periodEnd: "2026-09-05T00:00:00Z" },
        ]),
    };
  };

  const { commands } = createHarness({
    fetchImpl,
    readKey: () => "secret-key",
    now: () => new Date("2026-09-02T00:00:00Z"),
  });
  const ctx = createCtx();

  assert.ok(commands.has("nan"));
  assert.ok(commands.get("nan").description);

  await commands.get("nan").handler("", ctx);
  await commands.get("nan").handler("", ctx);

  assert.equal(fetchCount, 2, "manual invocation must not be throttled");
  assert.equal(ctx.notifications.length, 2);
  const message = ctx.notifications[0].message;
  const glmLine = message.split("\n").findIndex((l) => l.includes("glm"));
  const qwenLine = message.split("\n").findIndex((l) => l.includes("qwen"));
  assert.ok(glmLine < qwenLine, "most-constrained model listed first");
  assert.match(message, /qwen/);
  assert.match(message, /483k\s*\/\s*2\.0M/);
  assert.match(message, /24%/);
  assert.match(message, /3d/);
  assert.match(message, /glm/);
  assert.match(message, /30k\s*\/\s*100k/);
  assert.match(message, /30%/);
});

test("/nan command with no key shows the existing no-key notice", async () => {
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const { commands } = createHarness({ fetchImpl, readKey: () => "" });
  const ctx = createCtx();

  await commands.get("nan").handler("", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, "info");
  assert.match(ctx.notifications[0].message, /NAN_API_KEY/);
});

test("/nan command notifies an error on fetch failure", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };

  const { commands } = createHarness({ fetchImpl, readKey: () => "secret-key" });
  const ctx = createCtx();

  await commands.get("nan").handler("", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, "error");
  assert.match(ctx.notifications[0].message, /pi-nan/);
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

test("agent_end within the 5-minute throttle makes no fetch call", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => quotaResponse([{ model: "glm", tokensUsed: 10, cap: 100, periodEnd: "2026-09-05T00:00:00Z" }]) };
  };
  let clock = new Date("2026-09-02T00:00:00Z");

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => clock });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);
  assert.equal(fetchCalls, 1);

  clock = new Date("2026-09-02T00:04:00Z");
  await events.get("agent_end")({}, ctx);

  assert.equal(fetchCalls, 1);
  assert.equal(ctx.statuses.length, 1);
});

test("agent_end refreshes once 5 minutes have passed since the last fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => quotaResponse([{ model: "glm", tokensUsed: 10, cap: 100, periodEnd: "2026-09-05T00:00:00Z" }]) };
  };
  let clock = new Date("2026-09-02T00:00:00Z");

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => clock });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);
  assert.equal(fetchCalls, 1);

  clock = new Date("2026-09-02T00:05:01Z");
  await events.get("agent_end")({}, ctx);

  assert.equal(fetchCalls, 2);
  assert.equal(ctx.statuses.length, 2);
});

test("agent_end fetch failure after the throttle window leaves previous status untouched", async () => {
  let clock = new Date("2026-09-02T00:00:00Z");
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error("network down");
    return { ok: true, json: async () => quotaResponse([{ model: "glm", tokensUsed: 10, cap: 100, periodEnd: "2026-09-05T00:00:00Z" }]) };
  };

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => clock });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);
  const firstStatus = ctx.statuses[0];

  fail = true;
  clock = new Date("2026-09-02T00:05:01Z");
  await events.get("agent_end")({}, ctx);

  assert.equal(ctx.statuses.length, 1);
  assert.deepEqual(ctx.statuses[0], firstStatus);
  assert.equal(ctx.notifications.length, 0);
});

test("no key: agent_end inside the throttle window does not repeat the startup notice", async () => {
  let clock = new Date("2026-09-02T00:00:00Z");
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const { events } = createHarness({ fetchImpl, readKey: () => "", now: () => clock });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);
  assert.equal(ctx.notifications.length, 1);

  clock = new Date("2026-09-02T00:04:00Z");
  await events.get("agent_end")({}, ctx);

  assert.equal(ctx.notifications.length, 1);
});
