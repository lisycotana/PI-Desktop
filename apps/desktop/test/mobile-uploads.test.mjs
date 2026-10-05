import assert from "node:assert/strict";
import { mkdtemp, stat, mkdir, writeFile, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createMobileUploadStore } = await import("../electron/main/mobile/uploads.ts");

const session = "123e4567-e89b-12d3-a456-426614174000";
const otherSession = "123e4567-e89b-12d3-a456-426614174001";
const owner = { subject: "browser-a", roles: ["viewer", "controller", "approver"], pairedDevice: false };
const other = { subject: "browser-b", roles: ["viewer"], pairedDevice: false };
const input = (data = Buffer.from("hello").toString("base64")) => ({ name: "note.txt", mimeType: "text/plain", data });

test("upload store validates ownership, base64, and never returns a native path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mobile-upload-")); let time = Date.now();
  const store = createMobileUploadStore(dir, () => time); t.after(() => store.close());
  await assert.rejects(() => store.upload(owner, session, input("not-base64!")));
  const uploaded = await store.upload(owner, session, input());
  assert.deepEqual(Object.keys(uploaded).sort(), ["id", "kind", "mimeType", "name", "sha256", "size"]);
  await assert.rejects(() => store.resolve(other, session, [{ id: uploaded.id }]));
  await assert.rejects(() => store.resolve(owner, otherSession, [{ id: uploaded.id }]));
  assert.equal((await store.resolve(owner, session, [{ id: uploaded.id }]))[0].path.endsWith("note.txt"), false);
  time += 2 * 60 * 60 * 1000; await store.cleanup();
  await assert.doesNotReject(() => stat(join(dir, "scratch", session, "mobile")));
});

test("upload quotas reserve concurrent slots and expire only unconsumed files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mobile-upload-quota-")); let time = Date.now();
  const store = createMobileUploadStore(dir, () => time); t.after(() => store.close());
  const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => store.upload(owner, session, input(Buffer.from(String(i)).toString("base64")))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 8);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const accepted = results.find((result) => result.status === "fulfilled").value;
  await store.resolve(owner, session, [{ id: accepted.id }]);
  time += 2 * 60 * 60 * 1000; await store.cleanup();
  await assert.doesNotReject(() => store.resolve(owner, session, [{ id: accepted.id }]));
});

test("upload containment refuses junctions before creating anything outside the data root", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mobile-upload-link-")); const outside = await mkdtemp(join(tmpdir(), "pi-mobile-upload-outside-"));
  const store = createMobileUploadStore(dir); t.after(async () => {await store.close(); await rm(dir,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true});});
  await mkdir(join(dir,"scratch")); await symlink(outside,join(dir,"scratch",session),process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.upload(owner,session,input()),error => error.code === "FORBIDDEN");
  assert.deepEqual(await readdir(outside),[]);
});

test("upload integrity, shutdown cleanup and continuing session quotas preserve accepted queue files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mobile-upload-close-")); let time = Date.now();
  const store = createMobileUploadStore(dir,() => time); t.after(async () => {await store.close(); await rm(dir,{recursive:true,force:true});});
  const uploaded = await store.upload(owner,session,input()); const [accepted] = await store.resolve(owner,session,[uploaded.id]);
  await writeFile(accepted.path,"changed"); await assert.rejects(store.resolve(owner,session,[uploaded.id]),error => error.code === "FORBIDDEN");
  await writeFile(accepted.path,"hello");
  time += 2 * 60 * 60 * 1000; await store.cleanup();
  await Promise.all(Array.from({length:8},() => store.upload(owner,session,input(""))));
  await store.close(); assert.deepEqual(await readdir(join(dir,"scratch",session,"mobile")),[accepted.path.split(/[\\/]/).pop()]);
  await assert.rejects(store.upload(owner,session,input()),error => error.code === "AGENT_UNAVAILABLE");
});
