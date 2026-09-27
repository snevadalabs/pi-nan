import assert from "node:assert/strict";
import test from "node:test";

import nanExtension from "../index.js";

const CLOCK = new Date("2026-09-02T00:00:00Z");
const EXPECTED_URL = "https://api.nan.builders/v1/usage?start_date=2026-09-01&end_date=2026-09-02";

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

function usageResponse(byModel, overrides = {}) {
  return {
    object: "usage.report",
    start_date: "2026-09-01",
    end_date: "2026-09-26",
    data: [],
    totals: {
      total_tokens: byModel.reduce((sum, m) => sum + m.total_tokens, 0),
      api_requests: 0,
      by_model: byModel,
    },
    all_time: { total_tokens: 1_616_278_603 },
    has_more: false,
    next_cursor: null,
    ...overrides,
  };
}

test("session_start fetches usage for this month and shows the most-used model", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      json: async () =>
        usageResponse([
          { model: "glm5.3-flash", total_tokens: 30_000, api_requests: 12 },
          { model: "qwen3.8-flash", total_tokens: 483_000, api_requests: 40 },
        ]),
    };
  };

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, EXPECTED_URL);
  assert.equal(fetchCalls[0].opts.headers.Authorization, "Bearer secret-key");
  assert.ok(fetchCalls[0].opts.headers["User-Agent"]);

  assert.equal(ctx.statuses.length, 1);
  assert.equal(ctx.statuses[0].key, "nan");
  assert.match(ctx.statuses[0].text, /qwen3\.8-flash/);
  assert.match(ctx.statuses[0].text, /483k → 557k/);
  assert.match(ctx.statuses[0].text, /resets in 5d/);
  assert.equal(ctx.notifications.length, 0);
});

test("the projection scales tokens to the length of the month", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => usageResponse([{ model: "glm", total_tokens: 100, api_requests: 1 }], { end_date: "2026-02-10" }),
  });

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.match(ctx.statuses[0].text, /100 → 280/, "28-day February");
});

test("the projection counts a leap February as 29 days", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => usageResponse([{ model: "glm", total_tokens: 100, api_requests: 1 }], { end_date: "2028-02-10" }),
  });

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.match(ctx.statuses[0].text, /100 → 290/, "29-day February");
});

test("the reset countdown rolls over the year boundary", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => usageResponse([{ model: "glm", total_tokens: 10, api_requests: 1 }], { end_date: "2026-12-15" }),
  });

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.match(ctx.statuses[0].text, /resets in 17d/, "Dec 15 to Jan 1");
});

test("a response without end_date shows the raw count and no projection", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => usageResponse([{ model: "glm", total_tokens: 483_000, api_requests: 1 }], { end_date: undefined }),
  });

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.match(ctx.statuses[0].text, /483k/);
  assert.doesNotMatch(ctx.statuses[0].text, /→/);
  assert.doesNotMatch(ctx.statuses[0].text, /resets/);
});

test("session_start with no usage rows leaves the status untouched", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => usageResponse([]) });

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(ctx.statuses.length, 0);
  assert.equal(ctx.notifications.length, 0);
});

test("a model with zero tokens is never the most-used one", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () =>
      usageResponse([
        { model: "gemma4", total_tokens: 0, api_requests: 3 },
        { model: "glm5.3-flash", total_tokens: 10, api_requests: 1 },
      ]),
  });

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(ctx.statuses.length, 1);
  assert.match(ctx.statuses[0].text, /glm5\.3-flash/);
});

test("no key found: no status entry, exactly one startup notice", async () => {
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const { events } = createHarness({ fetchImpl, readKey: () => "", now: () => CLOCK });
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

  const { events } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(ctx.statuses.length, 0);
  assert.equal(ctx.notifications.length, 0);
});

test("non-ok response is treated as a fetch failure", async () => {
  const fetchImpl = async () => ({ ok: false });

  const { events, commands } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);

  assert.equal(ctx.statuses.length, 0);
  assert.equal(ctx.notifications.length, 0);

  await commands.get("nan").handler("", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, "error");
});

test("/nan lists every model, most-used first, with the all-time total", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () =>
      usageResponse([
        { model: "glm5.3-flash", total_tokens: 30_000, api_requests: 12 },
        { model: "qwen3.8-flash", total_tokens: 483_000, api_requests: 40 },
      ]),
  });

  const { commands } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  assert.ok(commands.has("nan"));
  assert.ok(commands.get("nan").description);

  await commands.get("nan").handler("", ctx);

  const message = ctx.notifications[0].message;
  const glmLine = message.split("\n").findIndex((l) => l.includes("glm5.3-flash"));
  const qwenLine = message.split("\n").findIndex((l) => l.includes("qwen3.8-flash"));
  assert.ok(qwenLine < glmLine, "most-used model listed first");
  assert.match(message, /qwen3\.8-flash: 483k → 557k \(40 req\)/);
  assert.match(message, /glm5\.3-flash: 30k → 34k \(12 req\)/);
  assert.match(message, /all time: 1\.6B/);
  assert.match(message, /resets in 5d/);
});

test("/nan bypasses the refresh throttle", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return {
      ok: true,
      json: async () => usageResponse([{ model: "glm5.3-flash", total_tokens: 10, api_requests: 1 }]),
    };
  };

  const { commands } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await commands.get("nan").handler("", ctx);
  await commands.get("nan").handler("", ctx);

  assert.equal(fetchCount, 2, "manual invocation must not be throttled");
  assert.equal(ctx.notifications.length, 2);
});

test("/nan formats billion-token usage with the B tier", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => usageResponse([{ model: "big", total_tokens: 1_500_000_000, api_requests: 7 }]),
  });

  const { commands } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await commands.get("nan").handler("", ctx);

  assert.match(ctx.notifications[0].message, /1\.5B/);
});

test("/nan with no key shows the existing no-key notice", async () => {
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const { commands } = createHarness({ fetchImpl, readKey: () => "", now: () => CLOCK });
  const ctx = createCtx();

  await commands.get("nan").handler("", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, "info");
  assert.match(ctx.notifications[0].message, /NAN_API_KEY/);
});

test("/nan with no key notifies every invocation, not once", async () => {
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const { commands } = createHarness({ fetchImpl, readKey: () => "", now: () => CLOCK });
  const ctx = createCtx();

  await commands.get("nan").handler("", ctx);
  await commands.get("nan").handler("", ctx);

  assert.equal(ctx.notifications.length, 2);
});

test("/nan notifies an error on fetch failure", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };

  const { commands } = createHarness({ fetchImpl, readKey: () => "secret-key", now: () => CLOCK });
  const ctx = createCtx();

  await commands.get("nan").handler("", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, "error");
  assert.match(ctx.notifications[0].message, /pi-nan/);
});

test("agent_end within the 5-minute throttle makes no fetch call", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => usageResponse([{ model: "glm5.3-flash", total_tokens: 10, api_requests: 1 }]) };
  };
  let clock = CLOCK;

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
    return { ok: true, json: async () => usageResponse([{ model: "glm5.3-flash", total_tokens: 10, api_requests: 1 }]) };
  };
  let clock = CLOCK;

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
  let clock = CLOCK;
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error("network down");
    return { ok: true, json: async () => usageResponse([{ model: "glm5.3-flash", total_tokens: 10, api_requests: 1 }]) };
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
  let clock = CLOCK;
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

test("no key: agent_end after the throttle window still does not repeat the startup notice", async () => {
  let clock = CLOCK;
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const { events } = createHarness({ fetchImpl, readKey: () => "", now: () => clock });
  const ctx = createCtx();

  await events.get("session_start")({}, ctx);
  clock = new Date("2026-09-02T00:05:01Z");
  await events.get("agent_end")({}, ctx);
  clock = new Date("2026-09-02T00:10:02Z");
  await events.get("agent_end")({}, ctx);

  assert.equal(ctx.notifications.length, 1);
});
