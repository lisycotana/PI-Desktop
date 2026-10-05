import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { RacpError } from "@pi-desktop/agent-host";
import { parseStatusZ, resolveRealPathForCreateWithinRoot, type HostRpc, type HostSessionRecord } from "@pi-desktop/host-runtime";

export type MobileDiffEntry = {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  untracked: boolean;
};
export type MobileDiffPage = {
  repo: boolean;
  clean: boolean;
  files: MobileDiffEntry[];
  offset: number;
  nextOffset?: number;
  total: number;
};
export type MobileDiffAccess = {
  list(sessionId: string, params: { offset?: number; limit?: number }): Promise<MobileDiffPage>;
  patch(sessionId: string, path: string): Promise<Readable>;
};

const GIT_OPTIONS = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "--no-pager"];
const git = (cwd: string, args: string[]) => spawn("git", [...GIT_OPTIONS, ...args], {
  cwd, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
});

/** Metadata is bounded with an explicit error, never a silently partial list. */
function captureGit(cwd: string, args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((done, fail) => {
    const child = git(cwd, args);
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill(); fail(new RacpError("AGENT_UNAVAILABLE", "diff metadata timed out"));
    }, 30_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        child.kill(); fail(new RacpError("PAYLOAD_TOO_LARGE", "diff metadata exceeds the transfer limit"));
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); fail(new RacpError("AGENT_UNAVAILABLE", "git is unavailable")); });
    child.once("close", (code) => { clearTimeout(timer); done({ code: code ?? 1, text: Buffer.concat(chunks).toString("utf8") }); });
  });
}

function safePath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value) || isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new RacpError("INVALID_ARGUMENT", "a workspace-relative path is required");
  }
  const path = value.replace(/\\/g, "/");
  if (path.split("/").some((part) => part === ".." || part === "")) throw new RacpError("REMOTE_PATH_FORBIDDEN", "path leaves the workspace");
  return path;
}

/** Full catalog and streamed patches complement the bounded shared preview. */
export function createMobileDiffAccess(getHost: () => HostRpc | null): MobileDiffAccess {
  const rootFor = async (sessionId: string) => {
    const host = getHost();
    if (!host) throw new RacpError("AGENT_UNAVAILABLE", "the desktop is unavailable");
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 });
    if (!result.session) throw new RacpError("NOT_FOUND", "session was not found");
    if (!result.session.projectPath) throw new RacpError("CONFLICT", "the session has no workspace");
    return realpath(result.session.projectPath);
  };
  const catalog = async (root: string): Promise<{ repo: boolean; files: MobileDiffEntry[] }> => {
    const prefix = await captureGit(root, ["rev-parse", "--show-prefix"]);
    if (prefix.code !== 0) return { repo: false, files: [] };
    const status = await captureGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
    if (status.code !== 0) throw new RacpError("AGENT_UNAVAILABLE", "workspace changes could not be read");
    const base = prefix.text.replace(/\r?\n$/, "");
    const local = (path: string) => base ? (path.startsWith(base) ? path.slice(base.length) : undefined) : path;
    const codes = new Map<string, string>();
    const rows = status.text.split("\0");
    for (let n = 0; n < rows.length; n++) {
      const row = rows[n];
      if (row.length < 4) continue;
      const code = row.slice(0, 2);
      codes.set(row.slice(3), code);
      if (/[RC]/.test(code)) n++;
    }
    const files = parseStatusZ(status.text).flatMap((entry): MobileDiffEntry[] => {
      const path = local(entry.path);
      if (!path) return [];
      const code = codes.get(entry.path) ?? " M";
      const oldPath = entry.oldPath ? local(entry.oldPath) : undefined;
      const kind = entry.untracked ? "untracked" : oldPath ? "renamed" : code.includes("D") ? "deleted" : code.includes("A") || /[RC]/.test(code) ? "added" : "modified";
      return [{ path, ...(oldPath ? { oldPath } : {}), status: kind, untracked: entry.untracked }];
    }).sort((a, b) => a.path.localeCompare(b.path));
    return { repo: true, files };
  };
  return {
    async list(sessionId, params) {
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RacpError("INVALID_ARGUMENT", "invalid diff page");
      const { repo, files } = await catalog(await rootFor(sessionId));
      const next = offset + limit;
      return { repo, clean: files.length === 0, files: files.slice(offset, next), offset, ...(next < files.length ? { nextOffset: next } : {}), total: files.length };
    },
    async patch(sessionId, value) {
      const path = safePath(value);
      const root = await rootFor(sessionId);
      const { repo, files } = await catalog(root);
      if (!repo) throw new RacpError("CONFLICT", "the workspace is not a git repository");
      const entry = files.find((file) => file.path === path);
      if (!entry) throw new RacpError("NOT_FOUND", "this file has no pending change");
      // Even a deleted path must have a canonical ancestor inside the root.
      const target = await resolveRealPathForCreateWithinRoot(root, path);
      if (!target || isAbsolute(relative(root, target)) || relative(root, target).startsWith("..")) throw new RacpError("REMOTE_PATH_FORBIDDEN", "path leaves the workspace");
      const head = entry.untracked ? undefined : await captureGit(root, ["rev-parse", "--verify", "HEAD"]);
      const base = head?.code === 0 ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const args = entry.untracked
        ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", path]
        : ["diff", base, "--relative", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--", path, ...(entry.oldPath ? [safePath(entry.oldPath)] : [])];
      const child = git(resolve(root), args);
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      const timer = setTimeout(() => { child.kill(); stream.destroy(new RacpError("AGENT_UNAVAILABLE", "patch transfer timed out")); }, 120_000);
      timer.unref();
      child.stderr.resume();
      child.stdout.pipe(stream, { end: false });
      child.once("error", () => stream.destroy(new RacpError("AGENT_UNAVAILABLE", "git is unavailable")));
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 || (entry.untracked && code === 1)) stream.end();
        else stream.destroy(new RacpError("AGENT_UNAVAILABLE", "the full patch could not be read"));
      });
      stream.once("close", () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
      return stream;
    },
  };
}
