import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { startMobileCompanion } = await import("../electron/main/mobile/readonly-server.ts");
const { createOperations } = await import("../electron/main/mobile/backend-operations.ts");
const { createMobileUploadStore } = await import("../electron/main/mobile/uploads.ts");
const { createMobileDiffAccess } = await import("../electron/main/mobile/diff-access.ts");
const { createMobileSessionData } = await import("../electron/main/mobile/session-data.ts");
const { DESKTOP_PRINCIPAL } = await import("../electron/main/agent-host-bridge.ts");
const { mobileFixture } = await import("./helpers/mobile-fixture.mjs");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-mobile-workflow-"));
  const project = join(directory, "project"); await mkdir(project);
  const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(project, "note.txt"), "before\n"); git("add", "note.txt"); git("commit", "-qm", "fixture");
  await writeFile(join(project, "note.txt"), "after\n");
  const f = mobileFixture({ id: "123e4567-e89b-12d3-a456-426614174000", projectPath: project });
  const uploads = createMobileUploadStore(directory);
  const enhancementCalls = [];
  const operations = createOperations({ getHost: () => f.host, isSessionBusy: id => !!f.bridge.agentHost.observeWorkTarget(id).activeTurnId, compact: async () => ({ accepted: true }), resolveAttachments: uploads.resolve });
  const server = await startMobileCompanion({ agentHost: f.bridge.agentHost, listSessions: operations.sessions.list, operations, confirmPairing: async () => true, uploadStore: uploads, diffAccess: createMobileDiffAccess(() => f.host), sessionData: createMobileSessionData(() => f.host, directory), getModels: async () => [{ providerId: "fixture", id: "model", thinkingLevels: ["high"] }], enhancePrompt: async request => {enhancementCalls.push(request);return {enhancedDraft:"Enhanced: " + request.draft};}, log: () => {} });
  t.after(async () => { await server.close(); await uploads.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.port}`;
  let cookie = ""; let csrf = "";
  const request = (path, init = {}) => fetch(base + path, { ...init, headers: { "X-PI-Origin": server.origin, Cookie: cookie, ...init.headers } });
  const paired = await request("/v1/browser/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: server.pairing.token }) });
  assert.equal(paired.status, 202); const pending = await paired.json(); let complete;
  for (let i = 0; i < 5; i += 1) { complete = await request("/v1/browser/pair/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: pending.requestId, secret: pending.secret }) }); const body = await complete.clone().json(); if (body.status !== "pending") break; await new Promise((resolve) => setImmediate(resolve)); }
  assert.equal(complete.status, 200); const result = await complete.json(); assert.equal(result.status, "approved"); cookie = complete.headers.get("set-cookie").split(";")[0]; csrf = result.csrf;
  const post = async (path, body) => {
    const response = await request(path, { method: "POST", headers: { "Content-Type": "application/json", "X-PI-CSRF": csrf }, body: JSON.stringify(body) });
    return response;
  };
  const action = async (method, params) => { const response = await post("/v1/action", { method, params }); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; };
  return { ...f, directory, server, request, post, action, enhancementCalls };
}

test("HTTP composer maps mode and enhancement to named desktop operations", async t => {
  const f = await fixture(t); const id = f.record.id;
  const capability = await (await f.request("/v1/capabilities")).json();
  assert.equal(capability.promptEnhancement,true);
  assert.equal(capability.remoteMaxPermissionMode,"ask");
  const configured = await f.action("session/configure",{sessionId:id,mode:"goal"});
  assert.equal(configured.session.mode,"goal");assert.equal(f.record.mode,"goal");
  assert.equal(f.record.permissionMode,"ask");
  const request = {sessionId:id,draft:"Improve this",providerId:"fixture",modelId:"model",thinkingLevel:"high"};
  assert.deepEqual(await f.action("prompt/enhance",request),{enhancedDraft:"Enhanced: Improve this"});
  assert.deepEqual(f.enhancementCalls,[request]);
  assert.equal((await f.post("/v1/action",{method:"prompt/enhance",params:{...request,apiKey:"never"}})).status,400);
  assert.equal((await f.post("/v1/action",{method:"prompt/enhance",params:{...request,draft:"/compact"}})).status,400);
  assert.equal(f.enhancementCalls.length,1);
  assert.equal(f.promptCalls.length,0);
  const denied = await f.request("/v1/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:"prompt/enhance",params:request})});
  assert.equal(denied.status,403);
});

test("HTTP task workflow uses the desktop Host for models, attachments, approvals, input, queue and controls", async t => {
  const f = await fixture(t); const id = f.record.id;
  assert.equal((await (await f.request("/v1/models")).json()).models[0].id, "model");
  assert.equal((await f.action("project/list", {})).projects[0].id, "1");
  const created = (await f.action("session/create", { title: "Phone task", projectId: "1", providerId: "fixture", modelId: "model", thinkingLevel: "high" })).session;
  assert.equal(created.permissionMode, "ask");
  await f.action("session/rename", { sessionId: created.id, title: "Renamed" });
  const fork = (await f.action("session/fork", { sessionId: created.id, title: "Fork" })).session;
  await f.action("session/compact", { sessionId: fork.id }); await f.action("session/delete", { sessionId: fork.id });
  assert.equal((await f.post("/v1/action", { method: "session/revoke", params: { deviceId: "desktop" } })).status, 403);
  const configuration = await (await f.request(`/v1/sessions/${created.id}/configuration`)).json();
  assert.deepEqual(configuration, { providerId: "fixture", modelId: "model", thinkingLevel: "high" });
  const uploaded = await (await f.post(`/v1/sessions/${id}/attachments`, { name: "phone.txt", mimeType: "text/plain", data: Buffer.from("phone file").toString("base64") })).json();
  f.record.permissionMode = "auto";
  const params = { sessionId: id, admission: "queue", idempotencyKey: "send-1", input: { text: "Continue", messageId: "user-1", attachments: [uploaded.id] }, context: { requestId: "send-1" } };
  const turn = (await f.action("turn/start", params)).turn;
  await f.action("turn/start", params); assert.equal(f.promptCalls.length, 1);
  assert.equal(f.promptCalls[0][0].permissionMode, "ask");
  assert.equal(f.promptCalls[0][0].attachments[0].name, "phone.txt");
  f.ingest(turn.id, { type: "agent_start" });
  f.ingest(turn.id, { type: "tool_permission_request", request: { requestId: "approval-1", sessionId: id, toolCallId: "tool-1", toolName: "Bash", argsPreview: { command: "fixture" }, risk: "high", reason: "Approve fixture" } });
  const attached = await (await f.post(`/v1/sessions/${id}:attach`, {})).json();
  assert.deepEqual(attached.snapshot.pendingApprovals[0].allowedDecisions, ["allow-once", "deny"]);
  const [phone, desktop] = await Promise.all([
    f.action("approval/respond", { approvalId: "approval-1", decision: "allow-once", context: { requestId: "approval-phone" } }),
    f.bridge.agentHost.respondApproval(DESKTOP_PRINCIPAL, { approvalId: "approval-1", decision: "deny", context: { requestId: "approval-desktop" } }),
  ]);
  assert.equal(phone.decision, desktop.decision);
  assert.equal(f.ipcCalls.filter(call => call.channel === IPC.invoke.toolResolvePermission).length, 1);
  f.ingest(turn.id, { type: "asktool_request", request: { requestId: "input-1", sessionId: id, toolCallId: "tool-2", questions: [{ question: "Choose", options: [{ label: "A", description: "Option A" }], multiSelect: true }, { question: "Explain", options: [] }] } });
  await f.action("input/respond", { inputId: "input-1", answers: [["A"], ["Free text"]], context: { requestId: "answer-1" } });
  assert.deepEqual(f.ipcCalls.find(call => call.channel === IPC.invoke.askToolResolve).args[0].answers, [["A"], ["Free text"]]);
  const queued = (await f.action("turn/start", { sessionId: id, admission: "queue", input: { text: "Later" }, context: { requestId: "queue-1" } })).turn;
  assert.equal(queued.status, "queued"); await f.action("turn/prioritize", { turnId: queued.id }); await f.action("turn/cancel", { turnId: queued.id });
  assert.equal(f.promptCalls.length, 1);
  await f.action("turn/stop", { turnId: turn.id }); await f.action("turn/interrupt", { turnId: turn.id });
  assert.ok(f.ipcCalls.some(call => call.channel === IPC.invoke.agentStop)); assert.ok(f.ipcCalls.some(call => call.channel === IPC.invoke.agentAbort));
});

test("HTTP history, complete changes, owned attachment reads and disconnect retain exact evidence", async t => {
  const f = await fixture(t); const id = f.record.id;
  const message = { id: "complete-message", role: "assistant", content: "Complete", thinking: "Returned thinking", createdAt: new Date().toISOString(), attachments: [{ ref: "note.txt", name: "note.txt", kind: "file", mimeType: "text/plain" }], status: "complete" };
  f.record.messages.push(message);
  const history = await (await f.request(`/v1/sessions/${id}/history`)).json();
  assert.deepEqual(history.items.at(-1).content, message);
  const attachment = await f.post(`/v1/sessions/${id}/attachment/read`, { messageId: message.id, ref: "note.txt" });
  assert.equal(attachment.status, 200); assert.equal(await attachment.text(), "after\n");
  assert.equal((await f.post(`/v1/sessions/${id}/attachment/read`, { messageId: "other-message", ref: "note.txt" })).status, 403);
  const changes = await (await f.post(`/v1/sessions/${id}/diff/list`, { limit: 100 })).json();
  assert.equal(changes.files[0].path, "note.txt");
  const patch = await f.post(`/v1/sessions/${id}/diff/patch`, { path: "note.txt" });
  assert.equal(patch.status, 200); const text = await patch.text(); assert.ok(text.includes("-before")); assert.ok(text.includes("+after"));
  await f.post("/v1/browser/logout", {});
  assert.equal((await f.request(`/v1/sessions/${id}/history`)).status, 401);
});
