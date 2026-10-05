import { createAgentHostBridge, DESKTOP_PRINCIPAL } from "../../electron/main/agent-host-bridge.ts";
import { randomUUID } from "node:crypto";
import { IPC } from "@pi-desktop/shared";
import { toSessionSummary } from "@pi-desktop/host-runtime";

/** In-memory external boundaries. No provider, Electron profile or real DB. */
export function mobileFixture({ messageCount = 2, id = "existing-desktop-session", projectPath = "F:/projects/PI-Desktop" } = {}) {
  const createdAt = "2026-10-03T08:00:00.000Z";
  const record = {
    id, title: "Mobile companion design", mode: "agent", permissionMode: "ask",
    projectPath, createdAt, updatedAt: createdAt,
    messages: Array.from({ length: messageCount }, (_, n) => ({
      id: `message-${n}`, role: n % 2 ? "assistant" : "user", createdAt,
      content: n === 0 ? "Can I follow this desktop session on my phone?" : n === 1 ? "Yes. This companion reads the same session from your desktop. The runtime and project stay on your computer." : `Earlier message ${n}`,
    })),
  };
  const records = new Map([[record.id,record]]);
  const queued = new Map();
  const calls = [];
  const ipcCalls = [];
  const promptCalls = [];
  let turn = 0;
  const host = { async call(method, params = {}) {
    calls.push({ method, params });
    if (method === "session.list") return { sessions: [...records.values()] };
    if (method === "projects.list") return { projects: [{ id: 1, name: "Preview project", path: record.projectPath }] };
    if (method === "session.get") return { session: records.get(params.id) || null };
    if (method === "session.queueList") return { entries: [...queued.values()] };
    if (method === "session.queuePush") { queued.set(params.id,{...params,createdAt:new Date().toISOString()}); return {}; }
    if (method === "session.queueRemove") return {removed:queued.delete(params.id)};
    if (method === "session.queuePrioritize") return {};
    if (method === "session.create" || method === "session.fork") { const parent = records.get(params.sessionId) || record; const created = {...parent,...params,id:randomUUID(),messages:method === "session.create" ? [] : [...parent.messages]}; records.set(created.id,created); return {session:created}; }
    if (method === "session.configure" || method === "session.rename") { Object.assign(records.get(params.id),params); return {}; }
    if (method === "session.delete") { records.delete(params.id); return {}; }
    if (method === "permissions.pending") return { requests: [] };
    throw new Error(`Unexpected host call: ${method}`);
  } };
  const bridge = createAgentHostBridge({
    channels: IPC.invoke, getHost: () => host, isSessionBusy: () => false, log: () => {},
    async invoke(channel, args) {
      ipcCalls.push({channel,args});
      if ([IPC.invoke.agentStop,IPC.invoke.agentAbort,IPC.invoke.askToolResolve,IPC.invoke.toolResolvePermission].includes(channel)) return {requested:true};
      if (channel !== IPC.invoke.agentPrompt) throw new Error(`Unexpected IPC: ${channel}`);
      promptCalls.push(args); return { turnId: `runtime-${++turn}` };
    },
  });
  let subscriptions = 0;
  const subscribe = bridge.agentHost.subscribe.bind(bridge.agentHost);
  const unsubscribe = bridge.agentHost.unsubscribe.bind(bridge.agentHost);
  bridge.agentHost.subscribe = (...args) => { const result = subscribe(...args); subscriptions++; return result; };
  bridge.agentHost.unsubscribe = (...args) => { const result = unsubscribe(...args); if (result) subscriptions--; return result; };
  return {
    record, records, host, bridge, calls, promptCalls, ipcCalls,
    subscriptions: () => subscriptions,
    listSessions: async () => [...records.values()].map(toSessionSummary),
    async desktopTurn() {
      const result = await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, { sessionId: record.id, input: { text: "Desktop continues" }, context: { requestId: `desktop-${turn}` } });
      return result.turn.id;
    },
    ingest(turnId, event) { bridge.ingest({ sessionId: record.id, turnId, ts: Date.now(), event }); },
  };
}
