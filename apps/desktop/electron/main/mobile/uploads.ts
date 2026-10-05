import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, stat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveRealPathForCreateWithinRoot, resolveRealPathWithinRoot } from "@pi-desktop/host-runtime";
import type { Principal } from "@pi-desktop/agent-host";
import type { AgentPromptAttachment } from "@pi-desktop/shared";
import { RacpError } from "@pi-desktop/agent-host";

const MAX_FILE = 10 * 1024 * 1024;
const MAX_SESSION = 40 * 1024 * 1024;
const TTL = 60 * 60 * 1000;
const NAME_MAX = 160;
const MIME = /^(?:image|text|application|audio|video)\/[A-Za-z0-9.+-]+$/;

type Item = { id: string; principal: string; sessionId: string; path: string; attachment: AgentPromptAttachment; expires: number; consumed: boolean; quotaReleased: boolean; sha256: string };
export type MobileUploadResult = { id: string; name: string; kind: "image" | "file"; mimeType: string; size: number; sha256: string };

export type MobileUploadStore = {
  upload(principal: Principal, sessionId: string, input: { name: string; mimeType: string; data: string }): Promise<MobileUploadResult>;
  resolve(principal: Principal, sessionId: string, refs: unknown[]): Promise<AgentPromptAttachment[]>;
  cleanup(): Promise<void>;
  close(): Promise<void>;
};

export function createMobileUploadStore(dataDir: string, now = Date.now): MobileUploadStore {
  const items = new Map<string, Item>();
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();
  const ownerKey = (principal: Principal, sessionId: string) => `${principal.subject}\0${sessionId}`;
  const ensureSession = (sessionId: string) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) throw new RacpError("INVALID_ARGUMENT", "invalid session id"); };
  const checkName = (name: string) => { if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name) || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new RacpError("INVALID_ARGUMENT", "invalid attachment name"); };
  async function uploadInner(principal: Principal, sessionId: string, input: { name: string; mimeType: string; data: string }) {
    if (closed) throw new RacpError("AGENT_UNAVAILABLE", "upload store is closed");
    ensureSession(sessionId); checkName(input.name);
    if (!MIME.test(input.mimeType)) throw new RacpError("INVALID_ARGUMENT", "unsupported MIME type");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 !== 0) throw new RacpError("INVALID_ARGUMENT", "invalid base64 data");
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.toString("base64") !== input.data) throw new RacpError("INVALID_ARGUMENT", "invalid base64 data");
    if (bytes.length > MAX_FILE) throw new RacpError("PAYLOAD_TOO_LARGE", "attachment exceeds 10 MiB");
    const key = ownerKey(principal, sessionId); const current = totals.get(key) ?? 0;
    if (current + bytes.length > MAX_SESSION || (counts.get(key) ?? 0) >= 8) throw new RacpError("PAYLOAD_TOO_LARGE", "session upload quota exceeded");
    // Reserve synchronously before the first await so concurrent uploads cannot oversubscribe.
    totals.set(key, current + bytes.length); counts.set(key, (counts.get(key) ?? 0) + 1);
    let path = "";
    try {
      await mkdir(dataDir, { recursive: true }); const dataRoot = await realpath(dataDir);
      const sessionDir = await resolveRealPathForCreateWithinRoot(dataRoot, `scratch/${sessionId}/mobile`);
      if (!sessionDir) throw new RacpError("FORBIDDEN", "invalid upload root");
      await mkdir(sessionDir, { recursive: true });
      const parent = await realpath(sessionDir);
      if (!await resolveRealPathWithinRoot(dataRoot, `scratch/${sessionId}/mobile`)) throw new RacpError("FORBIDDEN", "invalid upload root");
      path = join(parent, `${randomUUID()}-${randomBytes(8).toString("hex")}`);
      if (!(path.startsWith(`${parent}/`) || path.startsWith(`${parent}\\`))) throw new RacpError("FORBIDDEN", "invalid upload path");
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      if (closed) { await rm(path, { force: true }); throw new RacpError("AGENT_UNAVAILABLE", "upload store is closed"); }
    } catch (error) {
      totals.set(key, Math.max(0, (totals.get(key) ?? 0) - bytes.length)); counts.set(key, Math.max(0, (counts.get(key) ?? 1) - 1));
      throw error;
    }
    const id = randomUUID(); const attachment: AgentPromptAttachment = { path, name: input.name, kind: input.mimeType.startsWith("image/") ? "image" : "file", mimeType: input.mimeType, size: bytes.length };
    items.set(id, { id, principal: principal.subject, sessionId, path, attachment, expires: now() + TTL, consumed: false, quotaReleased: false, sha256: createHash("sha256").update(bytes).digest("hex") });
    return { id, name: attachment.name, kind: attachment.kind, mimeType: input.mimeType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  function upload(principal: Principal, sessionId: string, input: { name: string; mimeType: string; data: string }) {
    const operation = uploadInner(principal, sessionId, input);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  }
  async function resolve(principal: Principal, sessionId: string, refs: unknown[]) {
    if (closed) throw new RacpError("AGENT_UNAVAILABLE", "upload store is closed");
    ensureSession(sessionId); const result: AgentPromptAttachment[] = [];
    if (refs.length > 8) throw new RacpError("PAYLOAD_TOO_LARGE", "at most eight attachments are allowed");
    const consumed: Item[] = [];
    for (const ref of refs) {
      const id = typeof ref === "string" ? ref : ref && typeof ref === "object" && typeof (ref as { id?: unknown }).id === "string" ? (ref as { id: string }).id : "";
      if (!id) throw new RacpError("INVALID_ARGUMENT", "invalid attachment reference");
      const item = items.get(id);
      if (!item || item.principal !== principal.subject || item.sessionId !== sessionId || (item.expires <= now() && !item.consumed)) throw new RacpError("FORBIDDEN", "attachment is unavailable");
      const path = await resolveRealPathWithinRoot(dataDir, `scratch/${sessionId}/mobile/${item.path.split(/[\\/]/).pop()}`);
      if (!path || path !== item.path) throw new RacpError("FORBIDDEN", "attachment is unavailable");
      const info = await stat(path);
      if (!info.isFile() || info.size !== item.attachment.size || info.size > MAX_FILE) throw new RacpError("FORBIDDEN", "attachment integrity check failed");
      const bytes = await readFile(path).catch(() => { throw new RacpError("FORBIDDEN", "attachment is unavailable"); });
      if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new RacpError("FORBIDDEN", "attachment integrity check failed");
      consumed.push(item); result.push(item.attachment);
    }
    // Validate the whole batch before handing any files to durable admission.
    for (const item of consumed) item.consumed = true;
    return result;
  }
  async function cleanup() {
    const time = now();
    for (const [id, item] of items) if (closed || item.expires <= time) {
      if (!item.quotaReleased) {
        item.quotaReleased = true;
        const key = ownerKey({ subject: item.principal, roles: [] }, item.sessionId);
        totals.set(key, Math.max(0, (totals.get(key) ?? 0) - (item.attachment.size ?? 0)));
        counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
      }
      // Accepted queue files belong to desktop preparation, including after restart.
      if (!item.consumed) {
        items.delete(id);
        const path = await resolveRealPathWithinRoot(dataDir, `scratch/${item.sessionId}/mobile/${item.path.split(/[\\/]/).pop()}`);
        if (path === item.path) await rm(path, { force: true });
      }
    }
  }
  const timer = setInterval(() => { void cleanup().catch(() => {}); }, 5 * 60 * 1000); timer.unref();
  return { upload, resolve, cleanup, async close() { closed = true; clearInterval(timer); await Promise.allSettled([...pending]); await cleanup(); } };
}
