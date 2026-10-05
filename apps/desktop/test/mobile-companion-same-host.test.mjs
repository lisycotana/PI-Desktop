import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createAgentHostBridge, DESKTOP_PRINCIPAL } = await import(
  "../electron/main/agent-host-bridge.ts"
);
const {
  DeviceTokenAuthenticator,
  MemoryCredentialStore,
  RacpClient,
  RacpServer,
  bindRacpWebSocket,
  hashToken,
  newDeviceToken,
  wsClientTransport,
} = await import("@pi-desktop/racp");
const { RacpError } = await import("@pi-desktop/agent-host");
const { IPC } = await import("@pi-desktop/shared");

const SESSION_ID = "desktop-existing-session";
const CREATED_AT = "2026-10-02T08:00:00.000Z";

function sessionRecord() {
  return {
    id: SESSION_ID,
    title: "Existing desktop session",
    mode: "agent",
    permissionMode: "ask",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    messages: [
      {
        id: "message-existing-user",
        role: "user",
        content: "already on the desktop",
        createdAt: CREATED_AT,
      },
      {
        id: "message-existing-assistant",
        role: "assistant",
        content: "existing answer",
        createdAt: CREATED_AT,
      },
    ],
  };
}

function toSessionSummary(record) {
  return {
    id: record.id,
    title: record.title,
    mode: record.mode,
    permissionMode: record.permissionMode,
    planningState: "inactive",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function unavailable(name) {
  return async () => {
    throw new RacpError("CAPABILITY_UNAVAILABLE", `${name} is outside the probe`);
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function fixture(t) {
  const record = sessionRecord();
  const promptCalls = [];
  const persistedQueue = [];
  const hostCalls = [];

  const host = {
    async call(method, params = {}) {
      hostCalls.push({ method, params });
      switch (method) {
        case "session.get":
          return { session: params.id === SESSION_ID ? record : null };
        case "session.queueList":
          return { entries: persistedQueue };
        case "session.queuePush":
          persistedQueue.push({
            ...params,
            position: persistedQueue.length + 1,
            createdAt: new Date().toISOString(),
          });
          return { ok: true };
        case "session.queueRemove": {
          const index = persistedQueue.findIndex((entry) => entry.id === params.id);
          if (index < 0) return { removed: false };
          persistedQueue.splice(index, 1);
          return { removed: true };
        }
        case "session.queuePrioritize":
          return { ok: true };
        case "session.queueReorder":
          return { moved: false };
        case "permissions.pending":
          return { requests: [] };
        default:
          throw new Error(`unexpected fake host call: ${method}`);
      }
    },
  };

  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => host,
    isSessionBusy: () => false,
    log: () => undefined,
    async invoke(channel, [request]) {
      if (channel !== IPC.invoke.agentPrompt) {
        throw new Error(`unexpected fake IPC call: ${channel}`);
      }
      promptCalls.push(request);
      return { accepted: true, turnId: `desktop-runtime-${promptCalls.length}` };
    },
  });

  const operations = {
    sessions: {
      async list() {
        return [toSessionSummary(record)];
      },
      create: unavailable("session creation"),
      configure: unavailable("session configuration"),
      fork: unavailable("session fork"),
      rename: unavailable("session rename"),
      delete: unavailable("session deletion"),
      compact: unavailable("session compaction"),
    },
    projects: {
      async list() {
        return [];
      },
      register: unavailable("project registration"),
      browse: unavailable("project browsing"),
    },
    workspace: {
      list: unavailable("workspace listing"),
      read: unavailable("workspace reading"),
      diff: unavailable("workspace diff"),
    },
  };

  const token = newDeviceToken();
  const store = new MemoryCredentialStore();
  await store.saveDevice({
    deviceId: "mobile-viewer",
    label: "mobile companion probe",
    roles: ["viewer"],
    tokenHash: hashToken(token),
    createdAt: CREATED_AT,
  });
  const authenticator = new DeviceTokenAuthenticator(store);
  const server = new RacpServer({
    // This exact object is also the desktop bridge's authority. The probe must
    // never instantiate a second AgentHost or a second session database.
    agentHost: bridge.agentHost,
    operations,
    authenticator,
    hostId: "desktop-host-probe",
    serverName: "pi-desktop",
    serverVersion: "0.16.0",
    log: () => undefined,
    initializeTimeoutMs: 1_000,
  });
  const binding = await bindRacpWebSocket({
    server,
    authenticator,
    host: "127.0.0.1",
    port: 0,
    log: () => undefined,
  });
  t.after(async () => {
    server.close();
    await binding.close();
  });

  const url = `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`;
  const connect = async () => {
    const events = [];
    const client = new RacpClient({
      transport: wsClientTransport({ url, token }),
      client: { name: "mobile-companion-probe", version: "0.0.0" },
      onEvent: (event) => events.push(event),
      requestTimeoutMs: 2_000,
    });
    const initialized = await client.connect();
    return { client, events, initialized };
  };

  return { bridge, connect, hostCalls, promptCalls, server };
}

test("loopback RACP observes and resumes the desktop bridge's existing session without owner authority", async (t) => {
  const f = await fixture(t);
  const first = await f.connect();
  t.after(() => first.client.close());

  assert.deepEqual(first.initialized.principal, {
    subject: "mobile-viewer",
    roles: ["viewer"],
  });
  assert.notEqual(first.initialized.principal.subject, DESKTOP_PRINCIPAL.subject);
  assert.equal(first.initialized.principal.roles.includes("owner"), false);

  const listed = await first.client.request("session/list");
  assert.deepEqual(
    listed.sessions.map((session) => session.id),
    [SESSION_ID],
    "RACP must list the session already owned by the desktop host",
  );
  const attached = await first.client.request("session/attach", {
    sessionId: SESSION_ID,
    role: "viewer",
    includeSnapshot: true,
  });
  assert.equal(attached.session.id, SESSION_ID);
  assert.deepEqual(
    attached.snapshot.items.map((item) => item.id),
    ["message-existing-user", "message-existing-assistant"],
  );
  const history = await first.client.request("session/history", {
    sessionId: SESSION_ID,
    limit: 20,
  });
  assert.deepEqual(
    history.items.map((item) => item.id),
    ["message-existing-user", "message-existing-assistant"],
  );
  await assert.rejects(
    () => first.client.request("turn/start", {
      sessionId: SESSION_ID,
      input: { text: "must stay read-only in this probe" },
      context: { requestId: "remote-mutation-refused", idempotencyKey: "remote-mutation-refused" },
    }),
    (error) => error?.code === "FORBIDDEN",
    "the probe credential must not inherit desktop owner/controller authority",
  );

  await first.client.request("events/subscribe", {
    scope: "session",
    sessionId: SESSION_ID,
  });
  const desktopStart = await f.bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
    sessionId: SESSION_ID,
    input: { text: "desktop-owned turn" },
    context: { requestId: "desktop-local-start" },
  });
  const turnId = desktopStart.turn.id;
  f.bridge.ingest({
    sessionId: SESSION_ID,
    turnId,
    ts: Date.now(),
    event: { type: "agent_start" },
  });
  await waitFor(
    () => first.events.some((event) => event.kind === "turn.started"),
    "the loopback client did not receive the desktop turn event",
  );
  assert.equal(f.promptCalls.length, 1, "the desktop bridge's existing runtime must execute the turn");
  const started = first.events.find((event) => event.kind === "turn.started");
  const cursor = { epoch: started.epoch, sequence: started.sequence };

  await first.client.close();
  await waitFor(() => f.server.connectionCount() === 0, "the first RACP connection did not close");
  f.bridge.endTurn(SESSION_ID, turnId, "completed");

  const second = await f.connect();
  t.after(() => second.client.close());
  await second.client.request("events/subscribe", {
    scope: "session",
    sessionId: SESSION_ID,
    after: cursor,
  });
  await waitFor(
    () => second.events.some((event) => event.kind === "turn.completed"),
    "the reconnect did not replay the event produced while disconnected",
  );
  assert.equal(
    second.events.find((event) => event.kind === "turn.completed").turnId,
    turnId,
  );
  assert.ok(
    f.hostCalls.some((call) => call.method === "session.get" && call.params.id === SESSION_ID),
    "attach/history must read through the desktop bridge's Host port",
  );
});

// Controller promotion is exercised by mobile-task-workflow.test.mjs and the
// actual host-core per_turn_permission_scope execution tests.
