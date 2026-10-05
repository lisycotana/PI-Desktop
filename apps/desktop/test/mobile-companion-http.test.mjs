import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { startReadonlyMobile } = await import("../electron/main/mobile/readonly-server.ts");
const { createMobileCompanionBoot } = await import("../electron/main/bootstrap/mobile-companion.ts");
const { MOBILE_SESSION_LIFETIME } = await import("../electron/main/mobile/browser-auth.ts");
const { createMobileBrowserAuthorizationStore } = await import("../electron/main/mobile/browser-authorization-store.ts");
const { mobileAssets } = await import("../electron/main/mobile/web-assets.ts");
const { mobileFixture } = await import("./helpers/mobile-fixture.mjs");

async function fixture(t, options = {}) {
  const f = mobileFixture(options);
  const server = await startReadonlyMobile({ agentHost: f.bridge.agentHost, listSessions: f.listSessions, confirmPairing: async () => true, log: () => {}, ...options });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  let cookie = "";
  let csrf = "";
  const request = (path, init = {}) => fetch(base + path, { ...init, headers: { "X-PI-Origin": server.origin, Cookie: cookie, ...init.headers } });
  const pair = async () => {
    const response = await request("/v1/browser/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: server.pairing.token }) });
    assert.equal(response.status, 202); const pending = await response.json();
    let completed;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      completed = await request("/v1/browser/pair/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: pending.requestId, secret: pending.secret }) });
      const body = await completed.clone().json(); if (body.status !== "pending") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(completed.status, 200); const result = await completed.json(); assert.equal(result.status, "approved");
    cookie = completed.headers.get("set-cookie").split(";")[0]; csrf = result.csrf; return completed;
  };
  const attach = () => request(`/v1/sessions/${f.record.id}:attach`, { method: "POST", headers: { "X-PI-CSRF": csrf } });
  return { ...f, server, base, request, pair, attach, csrf: () => csrf };
}

async function stream(response) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); let buffer = ""; const decoder = new TextDecoder();
  return {
    close: () => reader.cancel(),
    async next() {
      for (;;) {
        const index = buffer.indexOf("\n\n");
        if (index >= 0) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (!frame.startsWith(":")) return frame;
        } else {
          const { value, done } = await reader.read();
          assert.equal(done, false, "event stream closed unexpectedly"); buffer += decoder.decode(value, { stream: true });
        }
      }
    },
  };
}

test("opt-in is disabled by default and browser assets are valid scripts", async (t) => {
  const f = mobileFixture();
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-default-")); t.after(() => rm(dataDir, { recursive: true }));
  const boot = createMobileCompanionBoot({ agentHost: f.bridge.agentHost, getHost: () => f.host, invoke: async () => assert.fail("default-off must not invoke IPC"), isSessionBusy: () => false, dataDir, env: {}, log: () => assert.fail("default-off must be silent") });
  await boot.open(); await boot.close();
  assert.deepEqual(await readdir(dataDir), []); assert.deepEqual(f.calls, []);
  new Script(mobileAssets["/app.js"].body); new Script(mobileAssets["/sw.js"].body);
  assert.equal(JSON.parse(mobileAssets["/manifest.webmanifest"].body).display, "standalone");
});

test("pairing enforces cookie, origin, CSRF and viewer-only authority", async (t) => {
  const f = await fixture(t, { publicOrigin: "https://desktop.example.ts.net" });
  assert.equal((await f.request("/v1/sessions")).status, 401);
  assert.equal((await f.request("/v1/browser/pair", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ token: f.server.pairing.token }) })).status, 403);
  const paired = await f.pair();
  assert.match(paired.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
  assert.equal((await f.request("/v1/browser/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: f.server.pairing.token }) })).status, 403);
  assert.equal((await f.request("/v1/sessions", { headers: { "X-PI-Origin": "https://evil.example" } })).status, 403);
  assert.equal((await f.request("/v1/sessions?token=forbidden")).status, 400);
  assert.equal((await f.request(`/v1/sessions/${f.record.id}:attach`, { method: "POST" })).status, 403);
  assert.equal((await f.attach()).status, 200);
  for (const path of ["/v1/turns:start", "/v1/approvals/approval:resolve", `/v1/sessions/${f.record.id}`]) {
    assert.equal((await f.request(path, { method: "POST", headers: { "X-PI-CSRF": f.csrf() }, body: "{}" })).status, 403);
  }
  assert.equal((await f.request("/v1/sessions", { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status, 403);
  const capabilities = await (await f.request("/v1/capabilities")).json(); assert.equal(capabilities.controls, false); assert.equal(capabilities.httpMapping, "readonly-subset");
  assert.deepEqual(f.promptCalls, []);
  assert.equal((await f.request("/v1/browser/logout", { method: "POST", headers: { "X-PI-CSRF": f.csrf() } })).status, 200);
  assert.equal((await f.request("/v1/sessions")).status, 401);
});

test("browser pairing fails closed when trusted desktop confirmation is absent", async (t) => {
  const f = mobileFixture();
  const server = await startReadonlyMobile({ agentHost: f.bridge.agentHost, listSessions: f.listSessions, log: () => {} });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/browser/pair`, { method: "POST", headers: { "X-PI-Origin": server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: server.pairing.token }) });
  assert.equal(response.status, 403);
});

test("pairing requires the completion secret and rejected confirmation never creates a cookie", async (t) => {
  const f = mobileFixture();
  const server = await startReadonlyMobile({ agentHost: f.bridge.agentHost, listSessions: f.listSessions, confirmPairing: async () => false, log: () => {} });
  t.after(() => server.close());
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { "X-PI-Origin": server.origin, ...init.headers } });
  const begin = await request("/v1/browser/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: server.pairing.token, label: "phone" }) });
  assert.equal(begin.status, 202); const pending = await begin.json();
  const wrong = await request("/v1/browser/pair/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: pending.requestId, secret: "wrong" }) });
  assert.equal(wrong.status, 403);
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = await request("/v1/browser/pair/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: pending.requestId, secret: pending.secret }) });
  assert.deepEqual(await rejected.json(), { status: "rejected" }); assert.equal(rejected.headers.get("set-cookie"), null);
});

test("pair cancellation preserves host and origin gates and revokes a delivered session", async (t) => {
  const f = mobileFixture();
  let approve;
  const server = await startReadonlyMobile({ agentHost: f.bridge.agentHost, listSessions: f.listSessions, confirmPairing: () => new Promise((resolve) => { approve = resolve; }), log: () => {}, publicOrigin: "https://desktop.example.ts.net" });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { "X-PI-Origin": server.origin, "Content-Type": "application/json" };
  const begin = await fetch(`${base}/v1/browser/pair`, { method: "POST", headers, body: JSON.stringify({ token: server.pairing.token, label: "phone" }) });
  assert.equal(begin.status, 202);
  const pending = await begin.json();
  const body = JSON.stringify({ requestId: pending.requestId, secret: pending.secret });

  const wrongOrigin = await fetch(`${base}/v1/browser/pair/cancel`, { method: "POST", headers: { ...headers, "X-PI-Origin": "https://evil.example", Origin: "https://evil.example" }, body });
  assert.equal(wrongOrigin.status, 403);
  // Fetch owns Host; use the HTTP boundary to send an actual mismatched authority.
  const wrongHost = await new Promise((resolve,reject)=>{const request=httpRequest(`${base}/v1/browser/pair/cancel`,{method:"POST",headers:{...headers,Host:"evil.example"}},response=>{response.resume();resolve({status:response.statusCode});});request.on("error",reject);request.end(body);});
  assert.equal(wrongHost.status, 403);
  const wrongSecret = await fetch(`${base}/v1/browser/pair/cancel`, { method: "POST", headers, body: JSON.stringify({ requestId: pending.requestId, secret: "wrong" }) });
  assert.equal(wrongSecret.status, 403);
  assert.equal(wrongSecret.headers.get("set-cookie"), null);

  const cancelled = await fetch(`${base}/v1/browser/pair/cancel`, { method: "POST", headers, body });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { status: "cancelled" });
  assert.match(cancelled.headers.get("set-cookie"), /Max-Age=0; Secure/);
  const complete = await fetch(`${base}/v1/browser/pair/complete`, { method: "POST", headers, body });
  assert.equal(complete.status, 403);
  assert.equal(complete.headers.get("set-cookie"), null);
  assert.deepEqual(server.listBrowsers(), []);

  const rotated = server.issuePairing();
  const secondBegin = await fetch(`${base}/v1/browser/pair`, { method: "POST", headers, body: JSON.stringify({ token: rotated.token, label: "phone" }) });
  const secondPending = await secondBegin.json();
  approve(true);
  await new Promise((resolve) => setImmediate(resolve));
  const secondBody = JSON.stringify({ requestId: secondPending.requestId, secret: secondPending.secret });
  const approved = await fetch(`${base}/v1/browser/pair/complete`, { method: "POST", headers, body: secondBody });
  assert.equal(approved.status, 200);
  assert.equal((await approved.clone().json()).status, "approved");
  const cookie = approved.headers.get("set-cookie").split(";")[0];
  const replay = await fetch(`${base}/v1/browser/pair/complete`, { method: "POST", headers, body: secondBody });
  assert.equal(replay.status, 403);

  const cancelDelivered = await fetch(`${base}/v1/browser/pair/cancel`, { method: "POST", headers: { ...headers, Cookie: cookie }, body: secondBody });
  assert.equal(cancelDelivered.status, 200);
  assert.match(cancelDelivered.headers.get("set-cookie"), /Max-Age=0; Secure/);
  assert.equal((await fetch(`${base}/v1/browser/session`, { headers: { "X-PI-Origin": server.origin, Cookie: cookie } })).status, 401);
});

test("revoking a browser session invalidates its cookie and closes streams", async (t) => {
  const f = await fixture(t); await f.pair(); const events = await stream(await f.request(`/v1/sessions/${f.record.id}/events`));
  const browser = f.server.listBrowsers()[0]; assert.ok(browser?.id);
  assert.equal(f.server.revokeBrowser(browser.id), true);
  await assert.rejects(() => events.next());
  assert.equal((await f.request("/v1/browser/session")).status, 401);
});

test("browser history reads the existing desktop session and pages earlier messages", async (t) => {
  const f = await fixture(t, { messageCount: 230 }); await f.pair();
  const listed = await (await f.request("/v1/sessions")).json(); assert.equal(listed.sessions[0].id, f.record.id);
  const latest = await (await f.request(`/v1/sessions/${f.record.id}/history`)).json();
  assert.equal(latest.items[0].id, "message-30"); assert.equal(latest.hasMore, true);
  const earlier = await (await f.request(`/v1/sessions/${f.record.id}/history`, { headers: { "X-PI-History-Before": latest.items[0].id } })).json();
  assert.equal(earlier.items[0].id, "message-0"); assert.equal(earlier.items.length, 30); assert.equal(earlier.hasMore, false);
  assert.equal((await f.request("/v1/sessions/missing/events")).status, 404); assert.equal(f.subscriptions(), 0);
  assert.ok(f.calls.some(call => call.method === "session.get" && call.params.id === f.record.id));
});

test("recorded reviews reuse desktop parsing and paginate independently of current Git state", async (t) => {
  const f = await fixture(t, { messageCount: 230 });
  const review = {version:1,snapshotId:"persisted-change",messageId:"message-0",path:"committed.txt",operation:"write",status:"added",state:"active",additions:1,deletions:0,reversible:true,hunks:[{header:"@@ -0,0 +1,1 @@",lines:[{type:"add",text:"Already committed evidence"}]}]};
  Object.assign(f.record.messages[0],{role:"tool",toolName:"Write",toolStatus:"success",toolResult:{details:{root:"workspace",review}}});
  // Malformed/unsuccessful tool evidence is rejected by the exact desktop parser.
  Object.assign(f.record.messages[229],{role:"tool",toolName:"Write",toolStatus:"error",toolResult:{details:{root:"workspace",review}}});
  const path = `/v1/sessions/${f.record.id}/review/list`;
  assert.equal((await f.request(path,{method:"POST",body:"{}",headers:{"Content-Type":"application/json"}})).status,401);
  await f.pair();
  assert.equal((await f.request(path,{method:"POST",body:"{}",headers:{"Content-Type":"application/json"}})).status,403);
  const read = body => f.request(path,{method:"POST",body:JSON.stringify(body),headers:{"Content-Type":"application/json","X-PI-CSRF":f.csrf()}});
  const latest = await (await read({})).json(); assert.deepEqual(latest.entries,[]); assert.equal(latest.hasMore,true); assert.equal(latest.nextBeforeItemId,"message-30");
  const earlier = await (await read({beforeItemId:latest.nextBeforeItemId})).json(); assert.equal(earlier.hasMore,false); assert.deepEqual(earlier.entries,[{messageId:"message-0",change:review}]);
  assert.ok(f.calls.every(call => !call.method.startsWith("workspace.")));
  f.record.messages[0].toolResult.details.review.state = "rolledBack";
  assert.equal((await (await read({beforeItemId:latest.nextBeforeItemId})).json()).entries[0].change.state,"rolledBack");
  assert.equal((await read({beforeItemId:[]})).status,400);
  assert.equal((await f.request("/v1/sessions/missing/review/list",{method:"POST",body:"{}",headers:{"Content-Type":"application/json","X-PI-CSRF":f.csrf()}})).status,404);
});

test("SSE follows desktop output and replays events produced during disconnect", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); await f.pair();
  const snapshot = await (await f.attach()).json();
  const eventsPath = `/v1/sessions/${f.record.id}/events`;
  const first = await stream(await f.request(eventsPath, { headers: { "Last-Event-ID": `${snapshot.snapshot.cursor.epoch}:${snapshot.snapshot.cursor.sequence}` } }));
  t.after(() => first.close());
  const turnId = await f.desktopTurn(); f.ingest(turnId, { type: "agent_start" });
  const started = JSON.parse((await first.next()).split("data: ")[1]); assert.equal(started.kind, "turn.started");
  const message = { id: "live-message", role: "assistant", content: "Live desktop answer", createdAt: new Date().toISOString(), status: "streaming" };
  f.ingest(turnId, { type: "message_start", message });
  const live = await (await f.attach()).json(); assert.equal(live.snapshot.activeItems[0].content.content, "Live desktop answer");
  await first.close(); f.bridge.endTurn(f.record.id, turnId, "completed");
  const second = await stream(await f.request(eventsPath, { headers: { "Last-Event-ID": `${started.epoch}:${started.sequence}` } })); t.after(() => second.close());
  let completed;
  for (let n = 0; n < 8; n++) { const frame = await second.next(); const event = JSON.parse(frame.split("data: ")[1]); if (event.kind === "turn.completed") { completed = event; break; } }
  assert.equal(completed.turnId, turnId); await second.close();
  const stale = await stream(await f.request(eventsPath, { headers: { "Last-Event-ID": "old-epoch:0" } })); t.after(() => stale.close());
  assert.match(await stale.next(), /event: resync/); await stale.close();
  await f.server.close(); assert.equal(f.subscriptions(), 0);
});

test("pairing codes and browser sessions expire", async (t) => {
  let time = Date.now(); const f = await fixture(t, { now: () => time }); await f.pair();
  time += MOBILE_SESSION_LIFETIME + 1;
  assert.equal((await f.request("/v1/sessions")).status, 401);
  const fresh = await fixture(t, { now: () => time }); time += 10 * 60_000;
  assert.equal((await fresh.request("/v1/browser/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: fresh.server.pairing.token }) })).status, 403);
});

test("desktop boot uses the shared Host and removes its private pairing file on shutdown", async (t) => {
  const f = mobileFixture();
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-boot-")); t.after(() => rm(dataDir, { recursive: true }));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const logs = [];
  const boot = createMobileCompanionBoot({ agentHost: f.bridge.agentHost, getHost: () => f.host, invoke: async () => assert.fail("no IPC call is expected in the boot probe"), isSessionBusy: () => false, confirmPairing: async () => true, dataDir, env: { PI_DESKTOP_MOBILE_ORIGIN: "https://desktop.example.ts.net", PI_DESKTOP_MOBILE_PORT: String(port) }, log: message => logs.push(message) });
  t.after(() => boot.close()); await boot.open();
  const setup = JSON.parse(await readFile(join(dataDir, "mobile-pairing.json"), "utf8"));
  assert.equal(setup.access, "controller"); assert.ok(logs.every(log => !log.includes(setup.pairingCode)));
  const headers = { "X-PI-Origin": setup.origin, "Content-Type": "application/json" };
  const paired = await fetch(`http://127.0.0.1:${port}/v1/browser/pair`, { method: "POST", headers, body: JSON.stringify({ token: setup.pairingCode }) });
  assert.equal(paired.status, 202); const pending = await paired.json();
  let complete;
  for (let i = 0; i < 5; i += 1) { complete = await fetch(`http://127.0.0.1:${port}/v1/browser/pair/complete`, { method: "POST", headers, body: JSON.stringify({ requestId: pending.requestId, secret: pending.secret }) }); const body = await complete.clone().json(); if (body.status !== "pending") break; await new Promise((resolve) => setImmediate(resolve)); }
  assert.equal(complete.status, 200); const completed = await complete.json(); assert.equal(completed.status, "approved");
  const listed = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { headers: { ...headers, Cookie: complete.headers.get("set-cookie").split(";")[0] } });
  assert.equal((await listed.json()).sessions[0].id, f.record.id);
  assert.ok(f.calls.some(call => call.method === "session.list"));
  await boot.close(); assert.deepEqual(await readdir(dataDir), ["mobile-browser-authorizations.json"]);const saved=await readFile(join(dataDir,"mobile-browser-authorizations.json"),"utf8");assert.equal(saved.includes(complete.headers.get("set-cookie").split(";")[0].split("=")[1]),false);
});

test("pairing is rate-limited and SSE sessions have a bounded stream count", async (t) => {
  const f = await fixture(t); await f.pair();
  const streams = [];
  t.after(() => Promise.all(streams.map(s => s.close())));
  for (let n = 0; n < 4; n++) streams.push(await stream(await f.request(`/v1/sessions/${f.record.id}/events`)));
  assert.equal((await f.request(`/v1/sessions/${f.record.id}/events`)).status, 429);
  assert.equal((await f.request(`/v1/sessions/${f.record.id}/events`, { headers: { "Last-Event-ID": "broken" } })).status, 429);
  for (let n = 0; n < 7; n++) assert.equal((await f.request("/v1/browser/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"token":"wrong"}' })).status, 403);
  assert.equal((await f.request("/v1/browser/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"token":"wrong"}' })).status, 429);
  await f.server.close(); assert.equal(f.subscriptions(), 0);
});

test("emulator boot allows only the exact configured loopback origin", async (t) => {
  const f = mobileFixture(); const dataDir = await mkdtemp(join(tmpdir(),"pi-mobile-emulator-")); t.after(() => rm(dataDir,{recursive:true}));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0,"127.0.0.1",resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const make = raw => createMobileCompanionBoot({agentHost:f.bridge.agentHost,getHost:() => f.host,invoke:async () => assert.fail("no IPC call"),isSessionBusy:() => false,confirmPairing:async () => true,dataDir,env:{PI_DESKTOP_MOBILE_ORIGIN:raw,PI_DESKTOP_MOBILE_PORT:String(port)},log:() => {}});
  for (const raw of [`http://localhost:${port}`,`http://[::1]:${port}`,`http://192.168.1.10:${port}`,`http://desktop.ts.net:${port}`,`http://127.0.0.1:${port+1}`,origin+"/",origin+"?x=1",origin+"#x",`http://user@127.0.0.1:${port}`,`http://127.0.0.1:${port}/../`,`http://127.1:${port}`]) {
    const boot = make(raw); await assert.rejects(boot.open(),/origin requires HTTPS/); await boot.close(); assert.deepEqual(await readdir(dataDir),[]);
  }
  const boot = make(origin); t.after(() => boot.close()); await boot.open();
  const setup = JSON.parse(await readFile(join(dataDir,"mobile-pairing.json"),"utf8")); assert.equal(setup.origin,origin);
  const response = await fetch(origin+"/v1/browser/pair",{method:"POST",headers:{"X-PI-Origin":origin,"Content-Type":"application/json"},body:JSON.stringify({token:setup.pairingCode})}); assert.equal(response.status,202); const pending=await response.json(); let complete; for(let i=0;i<5;i+=1){complete=await fetch(origin+"/v1/browser/pair/complete",{method:"POST",headers:{"X-PI-Origin":origin,"Content-Type":"application/json"},body:JSON.stringify({requestId:pending.requestId,secret:pending.secret})}); const body=await complete.clone().json(); if(body.status!=="pending")break; await new Promise(resolve=>setImmediate(resolve));} assert.equal(complete.status,200); assert.doesNotMatch(complete.headers.get("set-cookie") ?? "",/; Secure/); assert.match(complete.headers.get("set-cookie") ?? "",/HttpOnly; SameSite=Strict/);
  await boot.close();
});


test("trusted browser HTTP cookie survives a listener restart and persisted revocation",async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),"pi-mobile-http-trust-"));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const store=createMobileBrowserAuthorizationStore(dataDir);const origin="https://desktop.example.ts.net";const f=await fixture(t,{publicOrigin:origin,browserAuthorizationStore:store});const paired=await f.pair();const cookie=paired.headers.get("set-cookie").split(";")[0];const requestRestored=(path,init={})=>new Promise((resolve,reject)=>{const req=httpRequest({hostname:"127.0.0.1",port:f.server.port,path,method:init.method||"GET",agent:false,headers:{"X-PI-Origin":origin,Cookie:cookie,...init.headers}},res=>{let data="";res.setEncoding("utf8");res.on("data",part=>data+=part);res.on("end",()=>resolve({status:res.statusCode,json:async()=>JSON.parse(data)}));});req.on("error",reject);req.end();});const before=await(await f.request("/v1/browser/session")).json();const port=f.server.port;await f.server.close();
 const reopened=await startReadonlyMobile({agentHost:f.bridge.agentHost,listSessions:f.listSessions,port,publicOrigin:origin,browserAuthorizationStore:createMobileBrowserAuthorizationStore(dataDir),confirmPairing:()=>assert.fail("remembered browser must not ask for pairing"),log:()=>{}});t.after(()=>reopened.close());
 const restored=await requestRestored("/v1/browser/session");assert.equal(restored.status,200);const after=await restored.json();assert.notEqual(after.csrf,before.csrf);assert.equal((await requestRestored(`/v1/sessions/${f.record.id}:attach`,{method:"POST",headers:{"X-PI-CSRF":before.csrf}})).status,403);
 assert.equal((await requestRestored(`/v1/sessions/${f.record.id}:attach`,{method:"POST",headers:{"X-PI-CSRF":after.csrf}})).status,200);
 const id=reopened.listBrowsers()[0].id;assert.equal(reopened.revokeBrowser(id),true);assert.equal((await requestRestored("/v1/browser/session")).status,401);await reopened.close();
 const revoked=await startReadonlyMobile({agentHost:f.bridge.agentHost,listSessions:f.listSessions,port,publicOrigin:origin,browserAuthorizationStore:createMobileBrowserAuthorizationStore(dataDir),log:()=>{}});t.after(()=>revoked.close());assert.equal((await requestRestored("/v1/browser/session")).status,401);
});
