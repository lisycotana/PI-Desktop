import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { RacpError } from "@pi-desktop/agent-host";
import { resolveRealOpenablePath, type HostRpc, type HostSessionRecord } from "@pi-desktop/host-runtime";
import type { MessageAttachment } from "@pi-desktop/shared";

export type MobileSessionData = {
  configuration(sessionId: string): Promise<{ providerId?: string; modelId?: string; thinkingLevel?: string }>;
  attachment(sessionId: string, messageId: string, ref: string): Promise<{ stream: Readable; size: number; attachment: MessageAttachment }>;
};

/** Only durable session-owned references may authorize a browser file read. */
export function createMobileSessionData(getHost: () => HostRpc | null, dataDir: string): MobileSessionData {
  async function session(sessionId: string, messageId?: string) {
    const host = getHost();
    if (!host) throw new RacpError("AGENT_UNAVAILABLE", "the desktop is unavailable");
    const result = await host.call<{ session?: (HostSessionRecord & { providerId?: string; modelId?: string; thinkingLevel?: string }) | null }>("session.get", {
      id: sessionId, messageLimit: 1, ...(messageId ? { messageAround: messageId } : {}),
    });
    if (!result.session) throw new RacpError("NOT_FOUND", "session was not found");
    return result.session;
  }
  return {
    async configuration(sessionId) {
      const value = await session(sessionId);
      return {
        ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
        ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
        ...(typeof value.thinkingLevel === "string" ? { thinkingLevel: value.thinkingLevel } : {}),
      };
    },
    async attachment(sessionId, messageId, ref) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !messageId || messageId.length > 256 || !ref || ref.length > 4096 || ref.includes("\0")) throw new RacpError("INVALID_ARGUMENT", "invalid attachment reference");
      const value = await session(sessionId, messageId);
      const message = value.messages?.find(message => message.id === messageId);
      const attachment = message?.attachments?.find(attachment => attachment.ref === ref);
      if (!attachment) throw new RacpError("FORBIDDEN", "the attachment does not belong to this message");
      const path = await resolveRealOpenablePath(ref, value.projectPath, [join(dataDir, "scratch", sessionId), join(dataDir, "attachments")]);
      if (!path) throw new RacpError("REMOTE_PATH_FORBIDDEN", "the attachment is outside the session roots");
      const info = await stat(path);
      if (!info.isFile()) throw new RacpError("INVALID_ARGUMENT", "the attachment is not a file");
      return { stream: createReadStream(path), size: info.size, attachment };
    },
  };
}
