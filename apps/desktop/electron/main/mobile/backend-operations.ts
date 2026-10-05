import { basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RacpError, type Principal, type SessionSummary } from "@pi-desktop/agent-host";
import { collectWorkspaceDiff, listDir, readWorkspaceFile, toSessionSummary, type HostRpc, type HostSessionRecord } from "@pi-desktop/host-runtime";
import { THINKING_LEVELS, type AgentPromptAttachment, type PromptEnhancementRequest } from "@pi-desktop/shared";
import type { RacpHostOperations, SessionConfigureInput, SessionCreateInput } from "@pi-desktop/racp";
import type { RacpProjectSummary } from "@pi-desktop/shared";

export type MobileBackendOperationsOptions = {
  getHost: () => HostRpc | null;
  isSessionBusy: (sessionId: string) => boolean;
  compact: (sessionId: string) => Promise<{ accepted: boolean }>;
  disposeSession?: (sessionId: string) => Promise<void>;
  deleteSession?: (sessionId: string) => Promise<void>;
  models?: () => Promise<unknown[]>;
  resolveAttachments?: (principal: Principal, sessionId: string, refs: unknown[]) => Promise<AgentPromptAttachment[]>;
};

function fail(error: unknown): never {
  const code = (error as { data?: { errorCode?: string }; errorCode?: string })?.data?.errorCode ?? (error as { errorCode?: string })?.errorCode;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "NOT_FOUND" || code === "SESSION_NOT_FOUND") throw new RacpError("NOT_FOUND", message);
  if (code === "INVALID_PARAMS" || code === "INVALID_ARGUMENT") throw new RacpError("INVALID_ARGUMENT", message);
  if (code === "HOST_UNAVAILABLE") throw new RacpError("AGENT_UNAVAILABLE", message, { retriable: true });
  throw new RacpError("INTERNAL", message);
}

function host(options: MobileBackendOperationsOptions): HostRpc {
  const value = options.getHost();
  if (!value) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return value;
}

/** The browser maps this one named action onto PI's existing enhancement IPC. */
export function parseMobilePromptEnhancement(value: unknown): PromptEnhancementRequest & { sessionId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RacpError("INVALID_ARGUMENT", "invalid prompt enhancement request");
  const input = value as Record<string, unknown>;
  const fields = new Set(["sessionId", "draft", "providerId", "modelId", "thinkingLevel"]);
  if (Object.keys(input).some(key => !fields.has(key))) throw new RacpError("INVALID_ARGUMENT", "invalid prompt enhancement fields");
  if (typeof input.sessionId !== "string" || !input.sessionId.trim() || input.sessionId.length > 256) throw new RacpError("INVALID_ARGUMENT", "sessionId is required");
  if (typeof input.draft !== "string" || !input.draft.trim() || input.draft.trim().startsWith("/")) throw new RacpError("INVALID_ARGUMENT", "prompt draft cannot be empty or a slash command");
  if (Buffer.byteLength(input.draft, "utf8") > 256 * 1024) throw new RacpError("PAYLOAD_TOO_LARGE", "prompt draft is too large");
  for (const key of ["providerId", "modelId"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 512)) throw new RacpError("INVALID_ARGUMENT", `invalid ${key}`);
  }
  if (input.thinkingLevel !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(input.thinkingLevel)) throw new RacpError("INVALID_ARGUMENT", "invalid thinking level");
  return input as PromptEnhancementRequest & { sessionId: string };
}

export function createOperations(options: MobileBackendOperationsOptions): RacpHostOperations {
  async function record(sessionId: string): Promise<HostSessionRecord> {
    const result = await host(options).call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(fail);
    if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
    return result.session;
  }
  async function list(): Promise<SessionSummary[]> {
    const result = await host(options).call<{ sessions: HostSessionRecord[] }>("session.list", {}).catch(fail);
    const projects = await host(options).call<{ projects: Array<{ id: number; path: string }> }>("projects.list", {}).catch(fail);
    const byPath = new Map((projects.projects ?? []).map((project) => [project.path, String(project.id)]));
    return (result.sessions ?? []).map((record) => { const summary = toSessionSummary(record); const projectId = record.projectPath ? byPath.get(record.projectPath) : undefined; return projectId ? { ...summary, projectId } : summary; });
  }
  async function projectPathFor(projectId: string | undefined): Promise<string | undefined> {
    if (!projectId) return undefined;
    const result = await host(options).call<{ projects: Array<{ id: number; path: string }> }>("projects.list", {}).catch(fail);
    const project = (result.projects ?? []).find((item) => String(item.id) === projectId);
    if (!project) throw new RacpError("NOT_FOUND", `project ${projectId} is unknown`);
    return project.path;
  }
  const sessions = {
    list,
    async create(input: SessionCreateInput, _principal: Principal) {
      const projectPath = await projectPathFor(input.projectId);
      const value = await host(options).call<{ session?: HostSessionRecord | null }>("session.create", {
        ...(input.title ? { title: input.title } : {}), ...(input.mode ? { mode: input.mode } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(projectPath ? { projectPath } : {}),
      }).catch(fail);
      if (!value.session) throw new RacpError("INTERNAL", "session.create returned no session");
      // Browser-created sessions always begin at the narrow ask ceiling.
      await host(options).call("session.configure", { id: value.session.id, mode: value.session.mode ?? input.mode ?? "agent", permissionMode: "ask" }).catch(fail);
      return (await list()).find((item) => item.id === value.session!.id) ?? toSessionSummary(await record(value.session.id));
    },
    async configure(sessionId: string, input: SessionConfigureInput) {
      if (options.isSessionBusy(sessionId)) throw new RacpError("CONFLICT", "the session has an active turn");
      if (input.permissionMode !== undefined) throw new RacpError("FORBIDDEN", "browser cannot change permissionMode");
      const current = await record(sessionId);
      await host(options).call("session.configure", { id: sessionId, mode: input.mode ?? current.mode, ...(input.providerId !== undefined ? { providerId: input.providerId } : {}), ...(input.modelId !== undefined ? { modelId: input.modelId } : {}), ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}) }).catch(fail);
      return toSessionSummary(await record(sessionId));
    },
    async fork(sessionId: string, input: { title?: string; throughMessageId?: string }) {
      const value = await host(options).call<{ session?: HostSessionRecord | null }>("session.fork", { sessionId, ...(input.title ? { title: input.title } : {}), ...(input.throughMessageId ? { throughMessageId: input.throughMessageId } : {}) }).catch(fail);
      if (!value.session) throw new RacpError("INTERNAL", "session.fork returned no session");
      return (await list()).find((item) => item.id === value.session!.id) ?? toSessionSummary(await record(value.session.id));
    },
    async rename(sessionId: string, title: string) { await host(options).call("session.rename", { id: sessionId, title }).catch(fail); },
    async delete(sessionId: string) { if (options.isSessionBusy(sessionId)) throw new RacpError("CONFLICT", "the session has an active turn"); if (options.deleteSession) await options.deleteSession(sessionId); else { await host(options).call("session.delete", { id: sessionId }).catch(fail); await options.disposeSession?.(sessionId); } },
    compact: options.compact,
  };
  const projects = {
    async list(): Promise<RacpProjectSummary[]> { const value = await host(options).call<{ projects: Array<{ id: number; name: string; path: string }> }>("projects.list", {}).catch(fail); return (value.projects ?? []).map((p) => ({ id: String(p.id), label: p.name || basename(p.path), archived: false })); },
    async register(_path: string): Promise<RacpProjectSummary & { path: string }> { throw new RacpError("CAPABILITY_UNAVAILABLE", "project registration is not offered by the browser companion"); },
    async browse(_path?: string) { throw new RacpError("CAPABILITY_UNAVAILABLE", "project browsing is not offered by the browser companion"); },
  };
  async function root(sessionId: string): Promise<string> { const value = (await record(sessionId)).projectPath?.trim(); if (!value) throw new RacpError("CONFLICT", "the session has no project root"); return value; }
  const workspace = {
    async list(sessionId: string, path: string) { return { entries: await listDir(await root(sessionId), path).catch((e) => { throw new RacpError("REMOTE_PATH_FORBIDDEN", String(e)); }) }; },
    async read(sessionId: string, path: string) { if (!path) throw new RacpError("INVALID_ARGUMENT", "path is required"); return readWorkspaceFile(await root(sessionId), path).catch((e) => { throw new RacpError(/not a file/.test(String(e)) ? "INVALID_ARGUMENT" : "REMOTE_PATH_FORBIDDEN", String(e)); }); },
    async diff(sessionId: string) {
      const directory = await root(sessionId);
      // Shared previews use repository-relative paths. A registered project may
      // be a subdirectory: exclude sibling projects before returning evidence.
      const prefix = await promisify(execFile)("git", ["rev-parse", "--show-prefix"], { cwd: directory, windowsHide: true, timeout: 10_000 }).then(value => value.stdout.trim()).catch(() => "");
      const preview = await collectWorkspaceDiff(directory);
      if (!prefix) return preview;
      const files = preview.files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length), ...(file.oldPath ? { oldPath: file.oldPath.startsWith(prefix) ? file.oldPath.slice(prefix.length) : undefined } : {}) }));
      return { ...preview, files, clean: !files.length && !preview.truncated };
    },
  };
  return { sessions, projects, workspace, ...(options.resolveAttachments ? { attachments: { resolve: options.resolveAttachments } } : {}) };
}
