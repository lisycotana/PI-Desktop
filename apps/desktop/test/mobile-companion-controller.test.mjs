import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { startMobileCompanion } = await import("../electron/main/mobile/readonly-server.ts");
const { createOperations } = await import("../electron/main/mobile/backend-operations.ts");
const { mobileFixture } = await import("./helpers/mobile-fixture.mjs");

test("controller action reuses the existing AgentHost and requires CSRF", async (t) => {
  const f = mobileFixture();
  const operations = createOperations({ getHost: () => f.host, isSessionBusy: () => false, compact: async () => ({ accepted: true }) });
  const server = await startMobileCompanion({ agentHost: f.bridge.agentHost, listSessions: f.listSessions, operations, confirmPairing: async () => true, log: () => {} });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  let cookie = "";
  let csrf = "";
  const request = (path, init = {}) => fetch(base + path, { ...init, headers: { "X-PI-Origin": server.origin, Cookie: cookie, ...init.headers } });
  const paired = await request("/v1/browser/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: server.pairing.token }) });
  assert.equal(paired.status, 202);
  const pending = await paired.json(); let complete;
  for (let i = 0; i < 5; i += 1) { complete = await request("/v1/browser/pair/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: pending.requestId, secret: pending.secret }) }); const body = await complete.clone().json(); if (body.status !== "pending") break; await new Promise((resolve) => setImmediate(resolve)); }
  assert.equal(complete.status, 200); const result = await complete.json(); cookie = complete.headers.get("set-cookie").split(";")[0]; csrf = result.csrf;
  const noCsrf = await request("/v1/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "session/list", params: {} }) });
  assert.equal(noCsrf.status, 403);
  const listed = await request("/v1/action", { method: "POST", headers: { "Content-Type": "application/json", "X-PI-CSRF": csrf }, body: JSON.stringify({ method: "session/list", params: {} }) });
  assert.equal(listed.status, 200); assert.equal((await listed.json()).sessions[0].id, f.record.id);
  const started = await request("/v1/action", { method: "POST", headers: { "Content-Type": "application/json", "X-PI-CSRF": csrf }, body: JSON.stringify({ method: "turn/start", params: { sessionId: f.record.id, idempotencyKey: "mobile-1", input: { text: "continue" }, context: { requestId: "mobile-1" } } }) });
  assert.equal(started.status, 200); assert.equal(f.promptCalls.length, 1);
  const duplicate = await request("/v1/action", { method: "POST", headers: { "Content-Type": "application/json", "X-PI-CSRF": csrf }, body: JSON.stringify({ method: "turn/start", params: { sessionId: f.record.id, idempotencyKey: "mobile-1", input: { text: "continue" }, context: { requestId: "mobile-1" } } }) });
  assert.equal(duplicate.status, 200); assert.equal(f.promptCalls.length, 1);
});
