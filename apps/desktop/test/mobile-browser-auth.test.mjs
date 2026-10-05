import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  MOBILE_PAIRING_LIFETIME,
  MOBILE_SESSION_LIFETIME,
  createMobileBrowserAuth,
} = await import("../electron/main/mobile/browser-auth.ts");
const { createMobileBrowserAuthorizationStore } = await import("../electron/main/mobile/browser-authorization-store.ts");

async function approve(auth, label = "Phone") {
  const pairing = auth.issuePairing();
  const pending = auth.begin(pairing.token, label, "Test browser");
  await new Promise((resolve) => setImmediate(resolve));
  const completed = auth.complete(pending.requestId, pending.secret);
  assert.equal(completed.status, "approved");
  return completed;
}

test("a consumed near-expiry QR starts a fresh bounded approval window", async () => {
  let now = Date.parse("2026-10-04T00:00:00.000Z");
  const approvals = [];
  const requests = [];
  const auth = createMobileBrowserAuth({
    origin: () => "https://desktop.example.ts.net",
    roles: ["viewer"],
    now: () => now,
    confirmPairing: (request) => {
      requests.push(request);
      return new Promise((resolve) => approvals.push(resolve));
    },
  });

  const original = auth.getPairing();
  now = Date.parse(original.expiresAt) - 1_000;
  const pending = auth.begin(original.token, "Phone", "Test browser");
  assert.equal(Date.parse(pending.expiresAt), now + MOBILE_PAIRING_LIFETIME);
  await Promise.resolve();
  assert.equal(Date.parse(requests[0].expiresAt), now + MOBILE_PAIRING_LIFETIME);
  assert.throws(
    () => auth.begin(original.token, "Replay", "Test browser"),
    { code: "PAIRING_FAILED" },
  );

  now += MOBILE_PAIRING_LIFETIME;
  assert.throws(
    () => auth.complete(pending.requestId, pending.secret),
    { code: "PAIRING_FAILED" },
  );

  const rotatedFrom = auth.issuePairing();
  const superseded = auth.begin(rotatedFrom.token, "Tablet", "Test browser");
  await Promise.resolve();
  auth.issuePairing();
  approvals.at(-1)(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.throws(
    () => auth.complete(superseded.requestId, superseded.secret),
    { code: "PAIRING_FAILED" },
  );
  auth.close();
});

test("pair cancellation requires the completion secret and blocks late approval", async () => {
  let approve;
  let trustedRequest;
  const auth = createMobileBrowserAuth({
    origin: () => "https://desktop.example.ts.net",
    roles: ["viewer"],
    now: Date.now,
    confirmPairing: (request) => {
      trustedRequest = request;
      return new Promise((resolve) => { approve = resolve; });
    },
  });
  const pairing = auth.getPairing();
  const pending = auth.begin(pairing.token, "Phone", "Test browser");
  await Promise.resolve();
  assert.equal(trustedRequest.signal.aborted, false);

  assert.throws(
    () => auth.cancel(pending.requestId, "wrong-secret"),
    { code: "PAIRING_FAILED" },
  );
  assert.equal(trustedRequest.signal.aborted, false);
  assert.deepEqual(auth.complete(pending.requestId, pending.secret), { status: "pending" });

  assert.deepEqual(auth.cancel(pending.requestId, pending.secret), { status: "cancelled" });
  assert.equal(trustedRequest.signal.aborted, true);
  approve(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.throws(
    () => auth.complete(pending.requestId, pending.secret),
    { code: "PAIRING_FAILED" },
  );
  assert.deepEqual(auth.listBrowsers(), []);
  auth.close();
});

test("a completion receipt lets the same secret revoke a delivered session without replaying complete", async () => {
  const auth = createMobileBrowserAuth({
    origin: () => "https://desktop.example.ts.net",
    roles: ["viewer"],
    now: Date.now,
    confirmPairing: async () => true,
  });
  const pairing = auth.getPairing();
  const pending = auth.begin(pairing.token, "Phone", "Test browser");
  await new Promise((resolve) => setImmediate(resolve));
  const completed = auth.complete(pending.requestId, pending.secret);
  assert.equal(completed.status, "approved");
  assert.equal(auth.authenticate(completed.cookie).session.id, completed.session.id);
  assert.throws(() => auth.complete(pending.requestId, pending.secret), { code: "PAIRING_FAILED" });

  assert.throws(() => auth.cancel(pending.requestId, "wrong-secret"), { code: "PAIRING_FAILED" });
  assert.equal(auth.authenticate(completed.cookie).session.id, completed.session.id);
  assert.deepEqual(auth.cancel(pending.requestId, pending.secret), { status: "cancelled" });
  assert.throws(() => auth.authenticate(completed.cookie), { code: "REMOTE_AUTH_FAILED" });
  assert.throws(() => auth.cancel(pending.requestId, pending.secret), { code: "PAIRING_FAILED" });
  auth.close();
});

test("expired and rotated completion receipts do not revoke authenticated sessions", async () => {
  let now = Date.parse("2026-10-04T00:00:00.000Z");
  const makeAuth = () => createMobileBrowserAuth({
    origin: () => "https://desktop.example.ts.net",
    roles: ["viewer"],
    now: () => now,
    confirmPairing: async () => true,
  });

  const expiredAuth = makeAuth();
  let pairing = expiredAuth.getPairing();
  let pending = expiredAuth.begin(pairing.token, "Phone", "Test browser");
  await new Promise((resolve) => setImmediate(resolve));
  let completed = expiredAuth.complete(pending.requestId, pending.secret);
  now += MOBILE_PAIRING_LIFETIME;
  assert.throws(() => expiredAuth.cancel(pending.requestId, pending.secret), { code: "PAIRING_FAILED" });
  assert.equal(expiredAuth.authenticate(completed.cookie).session.id, completed.session.id);
  expiredAuth.close();

  const rotatedAuth = makeAuth();
  pairing = rotatedAuth.getPairing();
  pending = rotatedAuth.begin(pairing.token, "Tablet", "Test browser");
  await new Promise((resolve) => setImmediate(resolve));
  completed = rotatedAuth.complete(pending.requestId, pending.secret);
  rotatedAuth.issuePairing();
  assert.throws(() => rotatedAuth.cancel(pending.requestId, pending.secret), { code: "PAIRING_FAILED" });
  assert.equal(rotatedAuth.authenticate(completed.cookie).session.id, completed.session.id);
  rotatedAuth.close();
});

test("expiry, pairing rotation and shutdown abort trusted confirmations", async () => {
  let now = Date.parse("2026-10-04T00:00:00.000Z");
  const signals = [];
  const auth = createMobileBrowserAuth({
    origin: () => "https://desktop.example.ts.net",
    roles: ["viewer"],
    now: () => now,
    confirmPairing: (request) => {
      signals.push(request.signal);
      return new Promise(() => {});
    },
  });

  let pairing = auth.getPairing();
  let pending = auth.begin(pairing.token, "Phone", "Test browser");
  await Promise.resolve();
  now += MOBILE_PAIRING_LIFETIME;
  assert.throws(() => auth.complete(pending.requestId, pending.secret), { code: "PAIRING_FAILED" });
  assert.equal(signals[0].aborted, true);

  pairing = auth.issuePairing();
  auth.begin(pairing.token, "Tablet", "Test browser");
  await Promise.resolve();
  auth.issuePairing();
  assert.equal(signals[1].aborted, true);

  pairing = auth.getPairing();
  pending = auth.begin(pairing.token, "Laptop", "Test browser");
  await Promise.resolve();
  auth.close();
  assert.equal(signals[2].aborted, true);
  assert.throws(() => auth.cancel(pending.requestId, pending.secret), { code: "PAIRING_FAILED" });
});

test("approved browser authorization survives restart without persisting the cookie secret", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-auth-restart-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const origin = "https://desktop.example.ts.net";
  const makeAuth = () => createMobileBrowserAuth({
    origin: () => origin,
    roles: ["viewer", "controller", "approver"],
    now: Date.now,
    confirmPairing: async () => true,
    authorizationStore: createMobileBrowserAuthorizationStore(dataDir),
  });

  const first = makeAuth();
  const completed = await approve(first);
  const originalCsrf = completed.session.csrf;
  const stored = await readFile(join(dataDir, "mobile-browser-authorizations.json"), "utf8");
  assert.ok(!stored.includes(completed.cookie));
  assert.match(stored, /"cookieHash": "[0-9a-f]{64}"/);
  first.close();

  const restarted = makeAuth();
  const restored = restarted.authenticate(completed.cookie).session;
  assert.equal(restored.id, completed.session.id);
  assert.equal(restored.origin, origin);
  assert.notEqual(restored.csrf, originalCsrf);
  assert.deepEqual(restored.principal.roles, ["viewer", "controller", "approver"]);
  assert.equal(restored.principal.pairedDevice, false);
  assert.deepEqual(restored.capabilities, {});
  assert.equal(restored.authority, undefined);
  restarted.close();
});

test("native-approved personal task control is scoped to one browser and survives restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-auth-authority-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const origin = "https://desktop.example.ts.net";
  const makeAuth = () => createMobileBrowserAuth({
    origin: () => origin,
    roles: ["viewer", "controller", "approver"],
    now: Date.now,
    confirmPairing: async () => ({
      approved: true,
      taskControl: { maxPermissionMode: "auto", allowSessionGrants: true },
    }),
    authorizationStore: createMobileBrowserAuthorizationStore(dataDir),
  });

  const first = makeAuth();
  const completed = await approve(first, "Personal phone");
  assert.equal(completed.session.principal.pairedDevice, false);
  assert.deepEqual(completed.session.capabilities, {
    taskControl: { maxPermissionMode: "auto", allowSessionGrants: true },
  });
  assert.deepEqual(completed.session.authority, {
    kind: "personal-browser",
    principalSubject: completed.session.principal.subject,
    maxPermissionMode: "auto",
    allowSessionGrants: true,
  });
  first.close();

  const restarted = makeAuth();
  const restored = restarted.authenticate(completed.cookie).session;
  assert.deepEqual(restored.authority, {
    kind: "personal-browser",
    principalSubject: restored.principal.subject,
    maxPermissionMode: "auto",
    allowSessionGrants: true,
  });
  assert.equal(restarted.revokeBrowser(restored.id), true);
  assert.throws(() => restarted.authenticate(completed.cookie), { code: "REMOTE_AUTH_FAILED" });
  restarted.close();
});

test("legacy authorization records remain valid without gaining task-control authority", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-auth-legacy-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const origin = "https://desktop.example.ts.net";
  const store = createMobileBrowserAuthorizationStore(dataDir);
  const first = createMobileBrowserAuth({
    origin: () => origin,
    roles: ["viewer", "controller", "approver"],
    now: Date.now,
    confirmPairing: async () => true,
    authorizationStore: store,
  });
  const completed = await approve(first);
  first.close();

  const path = join(dataDir, "mobile-browser-authorizations.json");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  persisted.version = 1;
  for (const record of persisted.authorizations) delete record.capabilities;
  await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  const restarted = createMobileBrowserAuth({
    origin: () => origin,
    roles: ["viewer", "controller", "approver"],
    now: Date.now,
    confirmPairing: async () => assert.fail("legacy authorization must not pair again"),
    authorizationStore: createMobileBrowserAuthorizationStore(dataDir),
  });
  const restored = restarted.authenticate(completed.cookie).session;
  assert.deepEqual(restored.capabilities, {});
  assert.equal(restored.authority, undefined);
  assert.equal(restored.principal.pairedDevice, false);
  restarted.close();
});

test("expiry, revoke and logout remove persistent browser authorization", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-auth-revoke-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const origin = "https://desktop.example.ts.net";
  let now = Date.parse("2026-10-04T00:00:00.000Z");
  const makeAuth = () => createMobileBrowserAuth({
    origin: () => origin, roles: ["viewer"], now: () => now,
    confirmPairing: async () => true,
    authorizationStore: createMobileBrowserAuthorizationStore(dataDir),
  });

  let auth = makeAuth();
  const revoked = await approve(auth, "Revoked phone");
  auth.close(); auth = makeAuth();
  let ended = false;
  auth.authenticate(revoked.cookie).session.streams.add({ end() { ended = true; } });
  assert.equal(auth.revokeBrowser(revoked.session.id), true);
  assert.equal(ended, true);
  auth.close(); auth = makeAuth();
  assert.throws(() => auth.authenticate(revoked.cookie), { code: "REMOTE_AUTH_FAILED" });

  const loggedOut = await approve(auth, "Logged-out phone");
  const authenticated = auth.authenticate(loggedOut.cookie);
  auth.drop(authenticated.key);
  auth.close(); auth = makeAuth();
  assert.throws(() => auth.authenticate(loggedOut.cookie), { code: "REMOTE_AUTH_FAILED" });

  const expired = await approve(auth, "Expired phone");
  auth.close(); now += MOBILE_SESSION_LIFETIME;
  auth = makeAuth();
  assert.throws(() => auth.authenticate(expired.cookie), { code: "REMOTE_AUTH_FAILED" });
  assert.deepEqual(auth.listBrowsers(), []);
  auth.close();
});

test("persisted authorization is exact-origin bound and malformed stores fail closed", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-auth-origin-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = () => createMobileBrowserAuthorizationStore(dataDir);
  const auth = createMobileBrowserAuth({
    origin: () => "https://desktop-a.example.ts.net", roles: ["viewer"], now: Date.now,
    confirmPairing: async () => true, authorizationStore: store(),
  });
  const completed = await approve(auth); auth.close();

  const otherOrigin = createMobileBrowserAuth({
    origin: () => "https://desktop-b.example.ts.net", roles: ["viewer"], now: Date.now,
    confirmPairing: async () => true, authorizationStore: store(),
  });
  assert.throws(() => otherOrigin.authenticate(completed.cookie), { code: "REMOTE_AUTH_FAILED" });
  otherOrigin.close();

  const messages = [];
  await writeFile(join(dataDir, "mobile-browser-authorizations.json"), "{malformed", "utf8");
  const malformed = createMobileBrowserAuth({
    origin: () => "https://desktop-a.example.ts.net", roles: ["viewer"], now: Date.now,
    confirmPairing: async () => true,
    authorizationStore: createMobileBrowserAuthorizationStore(dataDir, message => messages.push(message)),
  });
  assert.throws(() => malformed.authenticate(completed.cookie), { code: "REMOTE_AUTH_FAILED" });
  assert.deepEqual(malformed.listBrowsers(), []);
  assert.deepEqual(messages, ["mobile browser authorization store ignored"]);
  malformed.close();
});
