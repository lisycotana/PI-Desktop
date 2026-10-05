import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Principal } from "@pi-desktop/agent-host";
import type { RacpPermissionMode } from "@pi-desktop/shared";

const STORE_VERSION = 2;
const MAX_RECORDS = 8;
const MAX_STORE_BYTES = 64 * 1024;
const ALLOWED_ROLES = new Set<Principal["roles"][number]>(["viewer", "controller", "approver"]);
const PERMISSION_MODES = new Set<RacpPermissionMode>(["ask", "accept-edits", "auto"]);

export type PersonalBrowserTaskControl = {
  maxPermissionMode: RacpPermissionMode;
  allowSessionGrants: boolean;
};

export type MobileBrowserCapabilities = {
  taskControl?: PersonalBrowserTaskControl;
};

export type PersistedBrowserAuthorization = {
  cookieHash: string;
  id: string;
  origin: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  roles: Principal["roles"];
  capabilities: MobileBrowserCapabilities;
};

export type MobileBrowserAuthorizationStore = {
  load(): PersistedBrowserAuthorization[];
  replace(records: readonly PersistedBrowserAuthorization[]): void;
};

function exactOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseCapabilities(value: unknown): MobileBrowserCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capabilities = value as Record<string, unknown>;
  if (Object.keys(capabilities).some((key) => key !== "taskControl")) return null;
  if (capabilities.taskControl === undefined) return {};
  if (!capabilities.taskControl || typeof capabilities.taskControl !== "object" || Array.isArray(capabilities.taskControl)) return null;
  const taskControl = capabilities.taskControl as Record<string, unknown>;
  if (
    Object.keys(taskControl).some((key) => !["maxPermissionMode", "allowSessionGrants"].includes(key)) ||
    typeof taskControl.maxPermissionMode !== "string" ||
    !PERMISSION_MODES.has(taskControl.maxPermissionMode as RacpPermissionMode) ||
    typeof taskControl.allowSessionGrants !== "boolean"
  ) return null;
  return {
    taskControl: {
      maxPermissionMode: taskControl.maxPermissionMode as RacpPermissionMode,
      allowSessionGrants: taskControl.allowSessionGrants,
    },
  };
}

function parseRecord(value: unknown, version = STORE_VERSION): PersistedBrowserAuthorization | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const capabilities = version === 1
    ? (record.capabilities === undefined ? {} : null)
    : parseCapabilities(record.capabilities);
  if (
    typeof record.cookieHash !== "string" || !/^[0-9a-f]{64}$/.test(record.cookieHash) ||
    typeof record.id !== "string" || !record.id || record.id.length > 256 ||
    !exactOrigin(record.origin) ||
    typeof record.label !== "string" || !record.label || record.label.length > 64 ||
    typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt)) ||
    !Array.isArray(record.roles) || !record.roles.length ||
    record.roles.some(role => typeof role !== "string" || !ALLOWED_ROLES.has(role as Principal["roles"][number])) ||
    !capabilities
  ) return null;
  return {
    cookieHash: record.cookieHash,
    id: record.id,
    origin: record.origin,
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    roles: [...new Set(record.roles as Principal["roles"])],
    capabilities,
  };
}

/** Atomic, credential-hash-only persistence for trusted mobile browsers. */
export function createMobileBrowserAuthorizationStore(
  dataDir: string,
  log: (message: string) => void = () => {},
): MobileBrowserAuthorizationStore {
  const path = join(dataDir, "mobile-browser-authorizations.json");
  return {
    load() {
      if (!existsSync(path)) return [];
      try {
        const text = readFileSync(path, "utf8");
        if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error("authorization store is too large");
        const parsed = JSON.parse(text) as { version?: unknown; authorizations?: unknown };
        if ((parsed.version !== 1 && parsed.version !== STORE_VERSION) || !Array.isArray(parsed.authorizations) || parsed.authorizations.length > MAX_RECORDS) throw new Error("invalid authorization store");
        const records = parsed.authorizations.map((record) => parseRecord(record, parsed.version as number));
        if (records.some(record => !record)) throw new Error("invalid authorization record");
        const valid = records as PersistedBrowserAuthorization[];
        if (new Set(valid.map(record => record.cookieHash)).size !== valid.length || new Set(valid.map(record => record.id)).size !== valid.length) throw new Error("duplicate authorization record");
        return valid;
      } catch {
        log("mobile browser authorization store ignored");
        return [];
      }
    },
    replace(records) {
      if (records.length > MAX_RECORDS || records.some(record => !parseRecord(record))) throw new Error("invalid mobile browser authorization state");
      mkdirSync(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.mobile-browser-authorizations-${randomUUID()}.tmp`);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporary, "wx", 0o600);
        writeFileSync(descriptor, `${JSON.stringify({ version: STORE_VERSION, authorizations: records }, null, 2)}\n`, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor); descriptor = undefined;
        renameSync(temporary, path);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        rmSync(temporary, { force: true });
      }
    },
  };
}
