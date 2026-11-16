import test from "node:test";
import assert from "node:assert/strict";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import {
  createRequestBudget,
  fetchGmgn1m,
  fetchTokenCreatedAt,
  gmgnIpv4Agent,
  gmgnRequestInit,
} from "../strategy/market-data.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clock = 1_700_000_000_000;

function candle(time) {
  return { time: time / 1000, open: "1", high: "1", low: "1", close: "1", volume: "1", amount: "1" };
}

test("GMGN requests use a fresh client id, a unix timestamp, and IPv4", async () => {
  const init = gmgnRequestInit("secret-key");
  assert.equal(init.family, 4);
  assert.equal(init.agent, gmgnIpv4Agent());
  assert.equal(init.agent.options.family, 4);
  assert.equal(init.headers["X-APIKEY"], "secret-key");

  const seen = [];
  const rules = { ...OWNER_STRATEGY, gmgnPageBars: 1, gmgnCandleCreditCost: 1, gmgnCreditLimit: 5 };
  const result = await fetchGmgn1m({
    rules,
    mint: "Mint",
    from: 0,
    to: 2 * 60_000,
    apiKey: "secret-key",
    now: () => clock,
    sleep: () => Promise.resolve(),
    budget: createRequestBudget(rules),
    fetchImpl: async (url, request) => {
      const query = new URL(url).searchParams;
      seen.push({
        clientId: query.get("client_id"),
        timestamp: query.get("timestamp"),
        family: request.family,
        agentFamily: request.agent.options.family,
        key: request.headers["X-APIKEY"],
      });
      const start = Number(query.get("from"));
      return { ok: true, status: 200, json: async () => ({ list: [candle(start)] }) };
    },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(call => call.timestamp === "1700000000"));
  assert.ok(seen.every(call => UUID.test(call.clientId)));
  assert.notEqual(seen[0].clientId, seen[1].clientId);
  assert.ok(seen.every(call => call.family === 4 && call.agentFamily === 4 && call.key === "secret-key"));
});

test("a GMGN retry uses a new client id and an auth failure is logged without the key", async () => {
  const logs = [];
  const ids = [];
  let attempts = 0;
  const rules = { ...OWNER_STRATEGY, gmgnPageBars: 10, gmgnCandleCreditCost: 1, gmgnCreditLimit: 5, gmgnWindowMs: 1000 };
  const retried = await fetchGmgn1m({
    rules,
    mint: "Mint",
    from: 0,
    to: 60_000,
    apiKey: "secret-key",
    now: () => clock,
    sleep: () => Promise.resolve(),
    budget: createRequestBudget(rules),
    log: (_category, message) => logs.push(message),
    fetchImpl: async url => {
      attempts += 1;
      ids.push(new URL(url).searchParams.get("client_id"));
      if (attempts === 1) {
        return { ok: false, status: 429, headers: { get: () => "0" }, json: async () => ({ message: "slow down" }) };
      }
      return { ok: true, status: 200, json: async () => ({ list: [candle(0)] }) };
    },
  });
  assert.equal(retried.ok, true, retried.reason);
  assert.equal(ids.length, 2);
  assert.ok(ids.every(id => UUID.test(id)));
  assert.notEqual(ids[0], ids[1]);
  assert.match(logs[0], /status 429 slow down/);
  assert.equal(logs.some(line => line.includes("secret-key")), false);

  const authLogs = [];
  const denied = await fetchTokenCreatedAt({
    rules,
    mint: "Mint",
    apiKey: "secret-key",
    now: () => clock,
    sleep: () => Promise.resolve(),
    budget: createRequestBudget(rules),
    log: (_category, message) => authLogs.push(message),
    fetchImpl: async (url, request) => {
      const query = new URL(url).searchParams;
      assert.equal(query.get("timestamp"), "1700000000");
      assert.match(query.get("client_id"), UUID);
      assert.equal(request.family, 4);
      assert.equal(request.agent.options.family, 4);
      assert.equal(String(url).includes("secret-key"), false);
      return { ok: false, status: 401, json: async () => ({ code: 401, message: "missing api key or client_id" }) };
    },
  });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /gmgn status 401 missing api key or client_id/);
  assert.match(authLogs[0], /status 401 missing api key or client_id/);
  assert.equal(authLogs[0].includes("secret-key"), false);
});
