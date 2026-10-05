import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { startMobileCompanion } = await import("../electron/main/mobile/readonly-server.ts");
const { mobileFixture } = await import("./helpers/mobile-fixture.mjs");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function fixture(t) {
  const f = mobileFixture();
  const uploads = [];
  const uploadStore = {
    async upload(_principal, _sessionId, input) {
      uploads.push(input);
      return { id: `upload-${uploads.length}`, name: input.name, kind: "file", mimeType: input.mimeType, size: Buffer.from(input.data, "base64").length, sha256: "fixture" };
    },
  };
  let attaches = 0;
  const attach = f.bridge.agentHost.attach.bind(f.bridge.agentHost);
  f.bridge.agentHost.attach = async (...args) => {
    attaches += 1;
    return attach(...args);
  };
  const server = await startMobileCompanion({ agentHost: f.bridge.agentHost, listSessions: f.listSessions, uploadStore, confirmPairing: async () => true, log: () => {} });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  async function pair(token = server.pairing.token) {
    const headers = { "X-PI-Origin": server.origin, "Content-Type": "application/json" };
    const begin = await fetch(`${base}/v1/browser/pair`, { method: "POST", headers, body: JSON.stringify({ token }) });
    assert.equal(begin.status, 202);
    const pending = await begin.json();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const complete = await fetch(`${base}/v1/browser/pair/complete`, { method: "POST", headers, body: JSON.stringify({ requestId: pending.requestId, secret: pending.secret }) });
      const result = await complete.json();
      if (result.status === "approved") {
        return { cookie: complete.headers.get("set-cookie").split(";")[0], csrf: result.csrf };
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("pairing did not complete");
  }
  const authHeaders = (auth) => ({
    "X-PI-Origin": server.origin,
    "X-PI-CSRF": auth.csrf,
    Cookie: auth.cookie,
    "Content-Type": "application/json",
  });
  const path = `/v1/sessions/${f.record.id}/attachments`;
  const upload = (auth, body) => fetch(base + path, { method: "POST", headers: authHeaders(auth), body: JSON.stringify(body) });
  const partial = (auth, firstChunk = '{"name":') => {
    let settle;
    const response = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const request = httpRequest(base + path, { method: "POST", headers: authHeaders(auth) }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => settle.resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", settle.reject);
    request.write(firstChunk);
    return { request, response };
  };
  return { ...f, server, uploads, pair, upload, partial, attaches: () => attaches };
}

test("upload ingress rejects a fifth unfinished body before buffering it and restores admission after errors", async (t) => {
  const f = await fixture(t);
  const auth = await f.pair();
  const pending = [];
  for (let index = 0; index < 4; index += 1) {
    pending.push(f.partial(auth));
    await waitFor(() => f.attaches() === index + 1, `upload ${index + 1} was not admitted`);
  }

  const rejected = f.partial(auth);
  const overload = await Promise.race([
    rejected.response,
    delay(1_000).then(() => assert.fail("fifth upload waited for its request body to finish")),
  ]);
  assert.equal(overload.status, 429);
  assert.equal(JSON.parse(overload.body).error.code, "RATE_LIMITED");
  rejected.request.destroy();

  for (const active of pending) active.request.end("!");
  const failures = await Promise.all(pending.map((active) => active.response));
  assert.deepEqual(failures.map((failure) => failure.status), [400, 400, 400, 400]);

  const restored = await f.upload(auth, { name: "restored.txt", mimeType: "text/plain", data: Buffer.from("ok").toString("base64") });
  assert.equal(restored.status, 201);
  assert.equal(f.uploads.length, 1);
});

test("upload ingress permits a valid body slower than the regular gate and revocation releases all browser slots", async (t) => {
  const f = await fixture(t);
  let auth = await f.pair();
  const body = JSON.stringify({ name: "slow.txt", mimeType: "text/plain", data: Buffer.from("slow phone").toString("base64") });
  const response = new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${f.server.port}/v1/sessions/${f.record.id}/attachments`, {
      method: "POST",
      headers: { "X-PI-Origin": f.server.origin, "X-PI-CSRF": auth.csrf, Cookie: auth.cookie, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.write(body.slice(0, 10));
    void delay(5_500).then(() => {
      request.write(body.slice(10, 20));
      return delay(5_500);
    }).then(() => request.end(body.slice(20))).catch(reject);
  });
  assert.equal((await response).status, 201);

  const attachBaseline = f.attaches();
  const pending = Array.from({ length: 4 }, () => f.partial(auth));
  await waitFor(() => f.attaches() === attachBaseline + 4, "four uploads were not admitted before revocation");
  for (const active of pending) void active.response.catch(() => undefined);
  const browser = f.server.listBrowsers()[0];
  assert.equal(f.server.revokeBrowser(browser.id), true);

  const pairing = f.server.issuePairing();
  auth = await f.pair(pairing.token);
  const restored = await f.upload(auth, { name: "after-revoke.txt", mimeType: "text/plain", data: Buffer.from("ok").toString("base64") });
  assert.equal(restored.status, 201);
});
