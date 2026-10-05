import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createOperations, parseMobilePromptEnhancement } = await import("../electron/main/mobile/backend-operations.ts");

test("mobile prompt enhancement accepts only the desktop draft contract", () => {
  const request = { sessionId:"session", draft:"Clarify this task", providerId:"provider", modelId:"model", thinkingLevel:"high" };
  assert.deepEqual(parseMobilePromptEnhancement(request), request);
  for (const input of [null, [], {}, {...request,draft:"  "}, {...request,draft:"/compact"}, {...request,sessionId:""}, {...request,thinkingLevel:"omit"}, {...request,thinkingLevel:"invented"}, {...request,apiKey:"secret"}, {...request,providerId:42}]) {
    assert.throws(() => parseMobilePromptEnhancement(input), error => error.code === "INVALID_ARGUMENT");
  }
  assert.throws(() => parseMobilePromptEnhancement({...request,draft:"汉".repeat(90000)}), error => error.code === "PAYLOAD_TOO_LARGE");
});

test("mobile backend maps project scope and keeps browser permission ceiling", async () => {
  const calls = [];
  const session = { id: "s1", title: "Desktop", mode: "agent", permissionMode: "ask", projectPath: "C:/work/app", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  const host = { async call(method, params) {
    calls.push({ method, params });
    if (method === "projects.list") return { projects: [{ id: 7, name: "app", path: "C:/work/app" }] };
    if (method === "session.list") return { sessions: [session, { ...session, id: "s2" }] };
    if (method === "session.get") return { session: params.id === "s1" || params.id === "s2" ? { ...session, id: params.id } : null };
    if (method === "session.create") return { session: { ...session, id: "s2" } };
    if (method === "session.configure") return {};
    throw new Error(`unexpected ${method}`);
  } };
  const operations = createOperations({ getHost: () => host, isSessionBusy: () => false, compact: async () => ({ accepted: true }) });
  const principal = { subject: "mobile", roles: ["viewer", "controller", "approver"], pairedDevice: false };
  const listed = await operations.sessions.list();
  assert.equal(listed[0].projectId, "7");
  const created = await operations.sessions.create({ projectId: "7", title: "new", permissionMode: "auto" }, principal);
  assert.equal(created.id, "s2");
  assert.deepEqual(calls.find((call) => call.method === "session.create").params.projectPath, "C:/work/app");
  assert.equal(calls.find((call) => call.method === "session.configure").params.permissionMode, "ask");
  await assert.rejects(() => operations.sessions.create({ projectId: "missing" }, principal));
  await assert.rejects(() => operations.sessions.configure("s1", { permissionMode: "auto" }));
});

test("mobile backend refuses deletion through raw Host RPC when IPC callback is supplied", async () => {
  const calls = []; let deleted = "";
  const session = { id: "s1", title: "Desktop", mode: "agent", permissionMode: "ask", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  const host = { async call(method) { calls.push(method); if (method === "session.get") return { session }; if (method === "session.list") return { sessions: [session] }; if (method === "projects.list") return { projects: [] }; return {}; } };
  const operations = createOperations({ getHost: () => host, isSessionBusy: () => false, compact: async () => ({ accepted: true }), deleteSession: async (id) => { deleted = id; } });
  await operations.sessions.delete("s1");
  assert.equal(deleted, "s1"); assert.equal(calls.includes("session.delete"), false);
});

test("mobile previews do not execute Git text converters or fsmonitor hooks and exclude sibling projects", async t => {
  const base = await mkdtemp(join(tmpdir(), "pi-mobile-preview-boundary-")); t.after(() => rm(base,{recursive:true,force:true}));
  const root = join(base,"project"); const inside = join(root,"inside"); await mkdir(inside,{recursive:true});
  const run = promisify(execFile); const git = (...args) => run("git",args,{cwd:root,windowsHide:true});
  await git("init","-q"); await git("config","user.name","Fixture"); await git("config","user.email","fixture@example.invalid");
  await writeFile(join(inside,"local.txt"),"old local\n"); await writeFile(join(root,"private.txt"),"old private\n"); await writeFile(join(root,".gitattributes"),"*.txt diff=fixture\n");
  await git("add","."); await git("commit","-qm","fixture");
  await writeFile(join(inside,"local.txt"),"new local\n"); await writeFile(join(root,"private.txt"),"private sibling change\n");
  const marker = join(base,"hook-ran"); const script = join(base,"hook.mjs");
  await writeFile(script,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');console.log('converted');`);
  const command = `node "${script.replaceAll("\\","/")}"`;
  await git("config","diff.fixture.textconv",command);
  await git("diff","HEAD","--","inside/local.txt"); await access(marker); await rm(marker);
  await git("config","core.fsmonitor",command);
  const host = {async call() {return {session:{id:"s1",projectPath:inside}};}};
  const operations = createOperations({getHost:() => host,isSessionBusy:() => false,compact:async () => ({accepted:true})});
  const preview = await operations.workspace.diff("s1");
  assert.deepEqual(preview.files.map(file => file.path),["local.txt"]);
  assert.ok(JSON.stringify(preview).includes("new local")); assert.ok(!JSON.stringify(preview).includes("private sibling change"));
  await assert.rejects(access(marker));
});
