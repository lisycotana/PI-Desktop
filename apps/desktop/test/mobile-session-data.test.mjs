import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createMobileSessionData } = await import("../electron/main/mobile/session-data.ts");
const id = "123e4567-e89b-12d3-a456-426614174000";

test("session data exposes current configuration and reads only a durable message-owned reference", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-mobile-session-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "file.txt"), "complete attachment");
  const message = { id: "m1", attachments: [{ ref: "file.txt", name: "file.txt", mimeType: "text/plain", kind: "file" }] };
  const calls = [];
  const host = { async call(method, params) { calls.push({method,params}); return {session:params.id === id ? {id,projectPath:root,messages:[message],providerId:"p",modelId:"m",thinkingLevel:"high",privateSecret:"never"} : null}; } };
  const data = createMobileSessionData(() => host, root);
  assert.deepEqual(await data.configuration(id), {providerId:"p",modelId:"m",thinkingLevel:"high"});
  const result = await data.attachment(id,"m1","file.txt"); let text = ""; for await (const chunk of result.stream) text += chunk;
  assert.equal(text, "complete attachment"); assert.equal(result.size, Buffer.byteLength(text));
  assert.equal(calls.at(-1).params.messageAround, "m1");
  await assert.rejects(data.attachment(id,"another","file.txt"), error => error.code === "FORBIDDEN");
  await assert.rejects(data.attachment(id,"m1","../secret"), error => error.code === "FORBIDDEN");
  await assert.rejects(data.configuration("missing"), error => error.code === "NOT_FOUND");
});

test("even an existing durable reference cannot authorize a junction outside its session roots", async t => {
  const base = await mkdtemp(join(tmpdir(), "pi-mobile-session-link-")); t.after(() => rm(base, {recursive:true,force:true}));
  const root = join(base,"project"); const outside = join(base,"outside"); await mkdir(root); await mkdir(outside); await writeFile(join(outside,"secret"),"private");
  await symlink(outside,join(root,"escape"),process.platform === "win32" ? "junction" : "dir");
  const ref = "escape/secret";
  const data = createMobileSessionData(() => ({async call() {return {session:{id,projectPath:root,messages:[{id:"m1",attachments:[{ref,name:"secret",kind:"file"}]}]}};}}),root);
  await assert.rejects(data.attachment(id,"m1",ref),error => error.code === "REMOTE_PATH_FORBIDDEN");
});
