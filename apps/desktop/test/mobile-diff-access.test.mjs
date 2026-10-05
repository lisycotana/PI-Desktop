import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createMobileDiffAccess } = await import("../electron/main/mobile/diff-access.ts");
const run = promisify(execFile);
async function git(root, ...args) { return run("git", args, { cwd: root, windowsHide: true }); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-mobile-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Mobile fixture");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "tracked.txt"), "old content\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "--quiet", "-m", "Fixture baseline");
  const host = { async call(method, params) {
    assert.equal(method, "session.get");
    return { session: params.id === "session" ? { id: "session", projectPath: root } : null };
  } };
  return { root, host, access: createMobileDiffAccess(() => host) };
}
async function text(stream) { let value = ""; for await (const chunk of stream) value += chunk.toString("utf8"); return value; }

test("full diff catalog paginates past the shared preview cap and preserves full patches", async t => {
  const { root, access } = await fixture(t);
  await Promise.all(Array.from({ length: 121 }, (_, n) => writeFile(join(root, `new-${String(n).padStart(3, "0")}.txt`), "new\n")));
  const longLine = "complete-result-".repeat(20_000);
  await writeFile(join(root, "tracked.txt"), `new content\n${longLine}\n`);
  const first = await access.list("session", { limit: 100 });
  assert.equal(first.total, 122);
  assert.equal(first.files.length, 100);
  assert.equal(first.nextOffset, 100);
  const second = await access.list("session", { offset: first.nextOffset, limit: 100 });
  assert.equal(second.files.length, 22);
  assert.equal(second.nextOffset, undefined);
  assert.equal(new Set([...first.files, ...second.files].map(f => f.path)).size, 122);
  const patch = await text(await access.patch("session", "tracked.txt"));
  assert.ok(Buffer.byteLength(patch) > 200 * 1024);
  assert.ok(patch.includes(`+${longLine}`));
  assert.ok(patch.includes("-old content"));
  const newPatch = await text(await access.patch("session", "new-000.txt"));
  assert.ok(newPatch.includes("+new"));
});

test("session subdirectory cannot disclose sibling repository files", async t => {
  const { root, host } = await fixture(t);
  await mkdir(join(root, "inside"));
  await writeFile(join(root, "inside", "local.txt"), "local baseline\n");
  await git(root, "add", "inside/local.txt");
  await git(root, "commit", "--quiet", "-m", "Scoped fixture");
  await writeFile(join(root, "tracked.txt"), "outside private change\n");
  await writeFile(join(root, "inside", "local.txt"), "local change\n");
  const localHost = { async call(method, params) { const result = await host.call(method, params); return result.session ? { session: { ...result.session, projectPath: join(root, "inside") } } : result; } };
  const access = createMobileDiffAccess(() => localHost);
  const page = await access.list("session", {});
  assert.deepEqual(page.files.map(file => file.path), ["local.txt"]);
  assert.ok((await text(await access.patch("session", "local.txt"))).includes("+local change"));
  await assert.rejects(access.patch("session", "../tracked.txt"), error => error.code === "REMOTE_PATH_FORBIDDEN");
  await assert.rejects(access.patch("session", "tracked.txt"), error => error.code === "NOT_FOUND");
});

test("diff paths are literal arguments, missing sessions and invalid pages fail explicitly", async t => {
  const { root, access } = await fixture(t);
  await writeFile(join(root, "--output=unexpected.txt"), "literal flag filename\n");
  const patch = await text(await access.patch("session", "--output=unexpected.txt"));
  assert.ok(patch.includes("+literal flag filename"));
  await assert.rejects(access.patch("session", join(root, "tracked.txt")), error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(access.list("missing", {}), error => error.code === "NOT_FOUND");
  await assert.rejects(access.list("session", { offset: -1 }), error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(access.list("session", { limit: 101 }), error => error.code === "INVALID_ARGUMENT");
});

test("binary changes retain binary metadata without inventing textual hunks", async t => {
  const { root, access } = await fixture(t);
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3, 4]));
  const patch = await text(await access.patch("session", "binary.dat"));
  assert.match(patch, /Binary files/);
  assert.doesNotMatch(patch, /@@/);
});

test("junction targets outside the session root are refused before patch reads", async t => {
  const { root, access } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "pi-mobile-diff-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "private.txt"), "external secret\n");
  try { await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("symlink creation unavailable"); return; } throw error; }
  await assert.rejects(access.patch("session", "escape/private.txt"), error => error.code === "REMOTE_PATH_FORBIDDEN" || error.code === "NOT_FOUND");
});
