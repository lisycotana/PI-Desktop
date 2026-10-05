import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type { AgentHost, SessionSummary } from "@pi-desktop/agent-host";
import { projectApprovalForPersonalBrowser, RacpError } from "@pi-desktop/agent-host";
import { RACP_DEFAULT_LIMITS, RACP_PROTOCOL_VERSION, RACP_OPERATIONS, rolesAllowOperation, RacpApprovalResponseSchema, type PromptEnhancementRequest, type PromptEnhancementResponse, type UiMessage, type RacpApprovalRequest, type RacpCursor, type RacpEventEnvelope, type RacpLimits, type RacpOperation, type RacpPermissionMode, type RacpRequestContext, type RacpServerCapabilities, type RacpSessionSnapshot } from "@pi-desktop/shared";
import { reviewChangesFromMessages } from "../../../src/lib/workspace-review";
import { createOperations as createRacpOperations, isLoopbackAddress, type RacpHostOperations } from "@pi-desktop/racp";
import * as Value from "typebox/value";
import { mobileAssets } from "./web-assets";
import type { BrowserAssets } from "./browser-assets";
import type { MobileUploadStore } from "./uploads";
import type { MobileSessionData } from "./session-data";
import { createMobileBrowserAuth, MOBILE_SESSION_LIFETIME, type MobilePairingDecision, type MobilePairingRequest, type BrowserSession } from "./browser-auth";
import type { MobileBrowserAuthorizationStore } from "./browser-authorization-store";
import { parseMobilePromptEnhancement } from "./backend-operations";
import type { NativeUiAuthority, createMobileNativeUiOperations } from "./native-ui-operations";

export type ReadonlyMobileOptions = {
  agentHost: AgentHost;
  listSessions: () => Promise<SessionSummary[]>;
  /** HTTPS origin of the tailnet entry. Omit only for isolated loopback development. */
  publicOrigin?: string;
  port?: number;
  now?: () => number;
  log: (message: string) => void;
  operations?: RacpHostOperations;
  getModels?: () => Promise<unknown[]>;
  uploadStore?: MobileUploadStore;
  sessionData?: MobileSessionData;
  browserAuthorizationStore?: MobileBrowserAuthorizationStore;
  enhancePrompt?: (request: PromptEnhancementRequest) => Promise<PromptEnhancementResponse>;
  /** Trusted desktop confirmation, never supplied by the browser itself. */
  confirmPairing?: (request: MobilePairingRequest) => Promise<MobilePairingDecision>;
  /** Fixed Main-owned UI operations. No IPC channel or method crosses HTTP. */
  nativeUiOperations?: ReturnType<typeof createMobileNativeUiOperations>;
  browserAssets?: BrowserAssets;
  /** Optional complete diff access supplied by the desktop bridge. */
  diffAccess?: {
    list(sessionId: string, input: { offset?: number; limit?: number }): Promise<unknown>;
    patch(sessionId: string, path: string): Promise<Readable>;
  };
};

const COOKIE = "pi_mobile_viewer";
const REGULAR_BODY_TIMEOUT = 10_000;
const UPLOAD_BODY_TIMEOUT = 5 * 60_000;
const MAX_UPLOAD_JSON_BYTES = 15 * 1024 * 1024 + 64 * 1024;
const MAX_UPLOADS_PER_BROWSER = 4;
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_ADMITTED_UPLOAD_BYTES = MAX_CONCURRENT_UPLOADS * MAX_UPLOAD_JSON_BYTES;
const MAX_NATIVE_UI_BODY_BYTES = 256 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest();

function equal(left: string, right: string): boolean {
  return timingSafeEqual(hash(left), hash(right));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class RequestBodyTimeoutError extends Error {}

async function readJson(request: IncomingMessage, maxBytes = 4096, timeoutMs = REGULAR_BODY_TIMEOUT): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new RacpError("INVALID_ARGUMENT", "JSON is required");
  }
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    let size = 0;
    const values: Buffer[] = [];
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(values);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        request.pause();
        finish(new RacpError("PAYLOAD_TOO_LARGE", "request is too large"));
        return;
      }
      values.push(buffer);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onAborted = () => finish(new Error("request was aborted"));
    const timer = setTimeout(() => {
      request.pause();
      finish(new RequestBodyTimeoutError("request body timed out"));
    }, timeoutMs);
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RacpError("INVALID_ARGUMENT", "invalid JSON");
  }
}

function parseCursor(value: string | undefined): RacpCursor | undefined {
  if (!value) return undefined;
  const match = /^([^:]{1,128}):(\d{1,15})$/.exec(value);
  if (!match) throw new RacpError("INVALID_ARGUMENT", "invalid event cursor");
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence)) throw new RacpError("INVALID_ARGUMENT", "invalid event cursor");
  return { epoch: match[1], sequence };
}

function exactObject(value: unknown, keys: readonly string[], label = "request"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RacpError("INVALID_ARGUMENT", `${label} must be an object`);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new RacpError("INVALID_ARGUMENT", `unknown ${label} field`);
  return input;
}

function requiredText(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new RacpError("INVALID_ARGUMENT", `invalid ${field}`);
  return value;
}

function browserAuthority(session: BrowserSession): NativeUiAuthority {
  return { maxPermissionMode: session.authority?.maxPermissionMode ?? "ask", principal: session.principal, authority: session.authority };
}

function browserAccess(session: BrowserSession) {
  const taskControl = session.capabilities.taskControl;
  return {
    maxAllowedPermissionMode: taskControl?.maxPermissionMode ?? "ask",
    allowSessionGrants: taskControl?.allowSessionGrants === true,
  };
}

function projectApproval(request: RacpApprovalRequest, session: BrowserSession): RacpApprovalRequest {
  return projectApprovalForPersonalBrowser(request, session.principal, session.authority);
}

function projectSnapshot(snapshot: RacpSessionSnapshot | undefined, session: BrowserSession): RacpSessionSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    pendingApprovals: snapshot.pendingApprovals.map((request) => projectApproval(request, session)),
  };
}

function projectEvent(event: RacpEventEnvelope, session: BrowserSession): RacpEventEnvelope {
  if (event.kind !== "approval.requested") return event;
  return { ...event, payload: projectApproval(event.payload as RacpApprovalRequest, session) };
}

function parseRequestContext(value: unknown): RacpRequestContext {
  const input = exactObject(value, ["requestId", "idempotencyKey", "expectedRevision", "traceparent"], "context");
  const requestId = requiredText(input.requestId, "requestId");
  if (input.idempotencyKey !== undefined) requiredText(input.idempotencyKey, "context idempotencyKey");
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0)) throw new RacpError("INVALID_ARGUMENT", "invalid expectedRevision");
  if (input.traceparent !== undefined) requiredText(input.traceparent, "traceparent", 512);
  return input as RacpRequestContext & { requestId: string };
}

/**
 * An opt-in browser companion over the desktop's existing AgentHost. The
 * unconfigured mode remains read-only; configured control mode uses the small
 * canonical action allowlist below and never exposes generic IPC.
 */
export async function startMobileCompanion(options: ReadonlyMobileOptions) {
  const now = options.now ?? Date.now;
  const browserRoles = options.operations ? ["viewer", "controller", "approver"] as const : ["viewer"] as const;
  let origin = "";
  let secure = false;
  let loopbackAuthority = "";
  if (options.publicOrigin) {
    const url = new URL(options.publicOrigin);
    if (url.origin !== options.publicOrigin || url.protocol !== "https:" || url.username || url.password) {
      throw new Error("mobile publicOrigin must be an exact HTTPS origin");
    }
    origin = url.origin;
    secure = true;
  }

  const browserAuth = createMobileBrowserAuth({origin:() => origin,roles:[...browserRoles],now,confirmPairing:options.confirmPairing,authorizationStore:options.browserAuthorizationStore});
  let closed = false;
  let admittedUploadBytes = 0;
  let concurrentUploads = 0;
  type UploadAdmission = { request: IncomingMessage; response: ServerResponse; release: () => void };
  const uploadsByBrowser = new Map<string, Set<UploadAdmission>>();
  const acquireUpload = (browserId: string, request: IncomingMessage, response: ServerResponse): UploadAdmission => {
    const active = uploadsByBrowser.get(browserId) ?? new Set<UploadAdmission>();
    if (closed || active.size >= MAX_UPLOADS_PER_BROWSER || concurrentUploads >= MAX_CONCURRENT_UPLOADS || admittedUploadBytes + MAX_UPLOAD_JSON_BYTES > MAX_ADMITTED_UPLOAD_BYTES) {
      response.shouldKeepAlive = false;
      response.setHeader("Connection", "close");
      request.resume();
      throw new RacpError("RATE_LIMITED", "too many concurrent uploads");
    }
    let released = false;
    const admission: UploadAdmission = {
      request,
      response,
      release() {
        if (released) return;
        released = true;
        concurrentUploads -= 1;
        admittedUploadBytes -= MAX_UPLOAD_JSON_BYTES;
        active.delete(admission);
        if (!active.size) uploadsByBrowser.delete(browserId);
      },
    };
    active.add(admission);
    uploadsByBrowser.set(browserId, active);
    concurrentUploads += 1;
    admittedUploadBytes += MAX_UPLOAD_JSON_BYTES;
    return admission;
  };
  const cancelUploads = (browserId?: string) => {
    const admissions = browserId === undefined
      ? [...uploadsByBrowser.values()].flatMap((active) => [...active])
      : [...(uploadsByBrowser.get(browserId) ?? [])];
    for (const admission of admissions) {
      admission.release();
      admission.response.destroy();
      admission.request.destroy();
    }
  };
  const drop = browserAuth.drop;
  const authenticate = (request: IncomingMessage): { key: string; session: BrowserSession } => {
    const cookies = request.headers.cookie?.split(";").map((part) => part.trim()) ?? [];
    const cookie = cookies.find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return browserAuth.authenticate(cookie);
  };
  const checkCsrf = (request: IncomingMessage, session: BrowserSession) => {
    const value = request.headers["x-pi-csrf"];
    if (typeof value !== "string" || !equal(value, session.csrf)) {
      throw new RacpError("FORBIDDEN", "request verification failed");
    }
  };
  const actionAllowlist = new Set<RacpOperation>([
    "session/list", "session/get", "session/create", "session/attach", "session/history", "session/configure", "session/fork", "session/rename", "session/delete", "session/compact",
    "project/list", "workspace/list", "workspace/read", "workspace/diff",
    "turn/start", "turn/get", "turn/stop", "turn/interrupt", "turn/cancel", "turn/prioritize", "approval/respond", "input/respond",
  ]);
  const limits: RacpLimits = { ...RACP_DEFAULT_LIMITS, maxPromptBytes: 256 * 1024 };
  const capabilities: RacpServerCapabilities = {
    eventReplay: true, snapshot: true, approvals: true, inputRequests: true,
    attachments: Boolean(options.operations?.attachments), serverRequests: false, turnQueue: true,
    hostEvents: true, history: true, remoteHostProfile: true, toolRelay: false,
    terminal: false, notifications: false, bindings: [],
  };
  const operationHandlers = options.operations ? createRacpOperations() : undefined;
  const dispatchAuthorityAction = async (session: BrowserSession, method: RacpOperation, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "approval/respond") {
      if (!Value.Check(RacpApprovalResponseSchema, params)) throw new RacpError("INVALID_ARGUMENT", "invalid approval response");
      return options.agentHost.respondApproval(session.principal, params, session.authority);
    }
    if (method !== "turn/start") return undefined;
    if (!options.operations) throw new RacpError("CAPABILITY_UNAVAILABLE", "control operations are not configured");
    const input = exactObject(params, ["sessionId", "idempotencyKey", "permissionModeCeiling", "admission", "input", "context"]);
    const sessionId = requiredText(input.sessionId, "sessionId");
    if (input.idempotencyKey !== undefined) requiredText(input.idempotencyKey, "idempotencyKey");
    const permissionModeCeiling = input.permissionModeCeiling;
    if (permissionModeCeiling !== undefined && !["ask", "accept-edits", "auto"].includes(permissionModeCeiling as string)) throw new RacpError("INVALID_ARGUMENT", "invalid permissionModeCeiling");
    const admission = input.admission;
    if (admission !== undefined && admission !== "reject_if_busy" && admission !== "queue") throw new RacpError("INVALID_ARGUMENT", "invalid admission");
    const prompt = exactObject(input.input, ["text", "attachments", "sessionMessageId", "messageId"], "turn input");
    if (typeof prompt.text !== "string") throw new RacpError("INVALID_ARGUMENT", "turn text is required");
    if (Buffer.byteLength(prompt.text, "utf8") > limits.maxPromptBytes) throw new RacpError("PAYLOAD_TOO_LARGE", "prompt exceeds maxPromptBytes");
    if (prompt.sessionMessageId !== undefined && typeof prompt.sessionMessageId !== "string") throw new RacpError("INVALID_ARGUMENT", "invalid sessionMessageId");
    if (prompt.messageId !== undefined && typeof prompt.messageId !== "string") throw new RacpError("INVALID_ARGUMENT", "invalid messageId");
    if (prompt.attachments !== undefined && !Array.isArray(prompt.attachments)) throw new RacpError("INVALID_ARGUMENT", "invalid attachments");
    const attachments = prompt.attachments?.length
      ? options.operations.attachments
        ? await options.operations.attachments.resolve(session.principal, sessionId, prompt.attachments)
        : (() => { throw new RacpError("CAPABILITY_UNAVAILABLE", "attachments are not offered by this Host"); })()
      : undefined;
    return options.agentHost.startTurn(session.principal, {
      sessionId,
      ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(permissionModeCeiling ? { permissionModeCeiling: permissionModeCeiling as RacpPermissionMode } : {}),
      ...(admission ? { admission: admission as "reject_if_busy" | "queue" } : {}),
      input: {
        text: prompt.text,
        ...(attachments ? { attachments } : {}),
        ...(typeof prompt.sessionMessageId === "string" && prompt.sessionMessageId ? { sessionMessageId: prompt.sessionMessageId } : {}),
        ...(typeof prompt.messageId === "string" && prompt.messageId ? { userMessageId: prompt.messageId } : {}),
      },
      context: parseRequestContext(input.context),
    }, session.authority);
  };
  const dispatchAction = async (session: BrowserSession, method: RacpOperation, params: Record<string, unknown>) => {
    // Personal browser pairing grants deletion of an idle conversation only.
    // It does not grant the owner role, pairing, terminal, or device management.
    // This explicit transport policy does not change canonical RACP role rules.
    const permitted = rolesAllowOperation(session.principal.roles, method) || (method === "session/delete" && session.principal.roles.includes("controller"));
    if (!actionAllowlist.has(method) || !RACP_OPERATIONS[method] || !permitted) throw new RacpError("FORBIDDEN", "operation is not available to the browser companion");
    const handler = operationHandlers?.get(method);
    if (!handler || !options.operations) throw new RacpError("CAPABILITY_UNAVAILABLE", "control operations are not configured");
    if (method === "turn/start" || method === "approval/respond") return dispatchAuthorityAction(session, method, params);
    const connection = { id: `mobile_${session.principal.subject}`, auth: { kind: "device" as const, principal: session.principal, device: { deviceId: session.principal.subject, label: "mobile browser", roles: session.principal.roles, tokenHash: "", createdAt: new Date(0).toISOString() } }, subscriptions: new Map(), terminals: new Set<string>() };
    return handler({ connection, principal: session.principal, agentHost: options.agentHost, operations: options.operations, authenticator: { pair: async () => { throw new RacpError("FORBIDDEN", "pairing is unavailable on the browser action transport"); } }, limits, capabilities, traceId: `mobile_${now()}`, now, deliverEvent: () => undefined, closeSubscription: () => undefined, log: (level: "info" | "warn" | "error", message: string) => options.log(`${level}: ${message}`) }, params);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RacpError("FORBIDDEN", "loopback is required");
    const authority = request.headers.host;
    if (authority !== new URL(origin).host && authority !== loopbackAuthority) {
      throw new RacpError("FORBIDDEN", "unknown host");
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.search || url.username || url.password) throw new RacpError("INVALID_ARGUMENT", "query credentials are not accepted");
    const assets: BrowserAssets = options.browserAssets ?? mobileAssets;
    const asset = assets[url.pathname];
    if (request.method === "GET" && asset) {
      const compressed=asset.gzip&&/\bgzip\b/.test(String(request.headers["accept-encoding"]));
      response.writeHead(200, { "Content-Type": asset.type, "Vary":"Accept-Encoding", ...(compressed?{"Content-Encoding":"gzip"}:{}) });
      response.end(compressed ? asset.gzip : asset.body);
      return;
    }
    // Same-origin fetch often omits Origin. This required custom header forces
    // cross-origin browsers through a preflight, which this server refuses.
    // It is a CSRF boundary, never a substitute for the paired cookie.
    if (request.headers["x-pi-origin"] !== origin || (request.headers.origin && request.headers.origin !== origin)) {
      throw new RacpError("FORBIDDEN", "unknown origin");
    }
    if (request.method === "POST" && url.pathname === "/v1/browser/pair") {
      const body = await readJson(request);
      json(response,202,browserAuth.begin(body.token,body.label,request.headers["user-agent"] || ""));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/browser/pair/cancel") {
      const body = await readJson(request);
      const result = browserAuth.cancel(body.requestId,body.secret);
      response.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
      json(response,200,result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/browser/pair/complete") {
      const body = await readJson(request);
      const result = browserAuth.complete(body.requestId,body.secret);
      if (result.status !== "approved") {json(response,200,{status:result.status});return;}
      response.setHeader("Set-Cookie", `${COOKIE}=${result.cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MOBILE_SESSION_LIFETIME / 1000}${secure ? "; Secure" : ""}`);
      json(response,200,{status:"approved",csrf:result.session.csrf,access:options.operations ? "controller" : "viewer",roles:result.session.principal.roles,...browserAccess(result.session)});
      return;
    }
    const { key, session } = authenticate(request);
    if (request.method === "GET" && url.pathname === "/v1/browser/session") {
      json(response, 200, { csrf: session.csrf, access: options.operations ? "controller" : "viewer", roles: session.principal.roles, ...browserAccess(session) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/browser/logout") {
      checkCsrf(request, session);
      drop(key);
      cancelUploads(session.id);
      response.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      json(response, 200, { protocolVersion: RACP_PROTOCOL_VERSION, httpMapping: options.operations ? "controller-subset" : "readonly-subset", access: options.operations ? "controller" : "viewer", eventReplay: true, snapshot: true, history: true, recordedReviews:true, controls: Boolean(options.operations), attachments: capabilities.attachments, sessionConfiguration: Boolean(options.sessionData), attachmentRead: Boolean(options.sessionData),promptEnhancement:Boolean(options.operations && options.enhancePrompt),remoteMaxPermissionMode:browserAccess(session).maxAllowedPermissionMode,maxAllowedPermissionMode:browserAccess(session).maxAllowedPermissionMode,allowSessionGrants:browserAccess(session).allowSessionGrants });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      json(response, 200, { models: await options.getModels?.() ?? [] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/action") {
      checkCsrf(request, session);
      const body = await readJson(request, limits.maxPromptBytes + 64 * 1024);
      if (typeof body.method !== "string" || !body.method || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) throw new RacpError("INVALID_ARGUMENT", "method and object params are required");
      if (body.method === "prompt/enhance") {
        if (!options.operations || !options.enhancePrompt || !session.principal.roles.includes("controller")) throw new RacpError("FORBIDDEN", "prompt enhancement is not available to this browser");
        const input = parseMobilePromptEnhancement(body.params);
        await options.agentHost.attach(session.principal,{sessionId:input.sessionId,role:"controller",includeSnapshot:false});
        json(response,200,await options.enhancePrompt(input));return;
      }
      json(response, 200, await dispatchAction(session, body.method as RacpOperation, body.params as Record<string, unknown>));
      return;
    }
    const configMatch = /^\/v1\/sessions\/([^/]+)\/configuration$/.exec(url.pathname);
    if (request.method === "GET" && configMatch) {
      if (!options.sessionData) throw new RacpError("CAPABILITY_UNAVAILABLE", "session configuration is unavailable");
      json(response, 200, await options.sessionData.configuration(decodeURIComponent(configMatch[1])));
      return;
    }
    const attachmentReadMatch = /^\/v1\/sessions\/([^/]+)\/attachment\/read$/.exec(url.pathname);
    if (request.method === "POST" && attachmentReadMatch) {
      checkCsrf(request, session);
      if (!options.sessionData) throw new RacpError("CAPABILITY_UNAVAILABLE", "attachment reading is unavailable");
      const body = await readJson(request, 8192);
      if (typeof body.messageId !== "string" || typeof body.ref !== "string") throw new RacpError("INVALID_ARGUMENT", "message and reference are required");
      const result = await options.sessionData.attachment(decodeURIComponent(attachmentReadMatch[1]), body.messageId, body.ref);
      result.stream.once("error", () => response.destroy());
      response.once("close", () => { if (!response.writableEnded) result.stream.destroy(); });
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": result.size, "Content-Disposition": "attachment; filename=pi-attachment", "X-PI-Attachment-Type": /^(?:image\/(?:png|jpeg|webp|gif))$/.test(result.attachment.mimeType ?? "") ? result.attachment.mimeType : "application/octet-stream" });
      result.stream.pipe(response);
      return;
    }
    const uploadMatch = /^\/v1\/sessions\/([^/]+)\/attachments$/.exec(url.pathname);
    if (request.method === "POST" && uploadMatch) {
      checkCsrf(request, session);
      if (!options.uploadStore) throw new RacpError("CAPABILITY_UNAVAILABLE", "attachments are not configured");
      const admission = acquireUpload(session.id, request, response);
      try {
        const sessionId = decodeURIComponent(uploadMatch[1]);
        await options.agentHost.attach(session.principal, { sessionId, role: "viewer", includeSnapshot: false });
        const body = await readJson(request, MAX_UPLOAD_JSON_BYTES, UPLOAD_BODY_TIMEOUT);
        if (typeof body.name !== "string" || typeof body.mimeType !== "string" || typeof body.data !== "string") throw new RacpError("INVALID_ARGUMENT", "name, mimeType and data are required");
        json(response, 201, await options.uploadStore.upload(session.principal, sessionId, { name: body.name, mimeType: body.mimeType, data: body.data }));
      } finally {
        admission.release();
      }
      return;
    }
    const nativeMatch = /^\/v1\/native\/(ui\/[a-z0-9/-]+)$/.exec(url.pathname);
    if (request.method === "POST" && nativeMatch) {
      checkCsrf(request, session);
      if (!options.nativeUiOperations) throw new RacpError("CAPABILITY_UNAVAILABLE", "native UI operations are not configured");
      const operation = nativeMatch[1];
      const viewerOperations = new Set([
        "ui/bootstrap", "ui/session/list", "ui/session/get", "ui/session/status", "ui/project/read", "ui/session/collaboration", "ui/todos/get",
        "ui/plans/pending", "ui/composer/commands", "ui/fs/index", "ui/fs/resolve",
        "ui/fs/read", "ui/fs/image", "ui/revision/list", "ui/interactive/pending", "ui/queue/list",
      ]);
      const requiredRole = viewerOperations.has(operation) ? "viewer" : "controller";
      if (!session.principal.roles.includes(requiredRole)) throw new RacpError("FORBIDDEN", "operation is not available to this browser");
      const historyOperation = operation === "ui/messages/replace" || operation === "ui/revision/save";
      const body = await readJson(request, historyOperation ? 8 * 1024 * 1024 : MAX_NATIVE_UI_BODY_BYTES);
      // The operation is selected only by the fixed path. Request bodies can
      // never smuggle an IPC channel/method into the Main process.
      if (Object.hasOwn(body, "channel") || Object.hasOwn(body, "method")) throw new RacpError("INVALID_ARGUMENT", "channel and method fields are not accepted");
      json(response, 200, await options.nativeUiOperations.dispatch(operation, body, browserAuthority(session)));
      return;
    }
    const diffListMatch = /^\/v1\/sessions\/([^/]+)\/diff\/list$/.exec(url.pathname);
    const reviewListMatch = /^\/v1\/sessions\/([^/]+)\/review\/list$/.exec(url.pathname);
    if (request.method === "POST" && reviewListMatch) {
      checkCsrf(request,session);
      const body = await readJson(request);
      if (body.beforeItemId !== undefined && (typeof body.beforeItemId !== "string" || !body.beforeItemId || body.beforeItemId.length > 256)) throw new RacpError("INVALID_ARGUMENT","invalid review cursor");
      const sessionId = decodeURIComponent(reviewListMatch[1]);
      await options.agentHost.attach(session.principal,{sessionId,role:"viewer",includeSnapshot:false});
      const history = await options.agentHost.history(session.principal,{sessionId,limit:200,...(typeof body.beforeItemId === "string" ? {beforeItemId:body.beforeItemId} : {})});
      const messages = history.items.map(item => item.content).filter((value): value is UiMessage => Boolean(value && typeof value === "object" && "role" in value));
      json(response,200,{entries:reviewChangesFromMessages(messages).map(({message,change}) => ({messageId:message.id,change})),hasMore:history.hasMore,...(history.hasMore && history.items[0] ? {nextBeforeItemId:history.items[0].id} : {})});
      return;
    }
    if (request.method === "POST" && diffListMatch) {
      checkCsrf(request, session);
      if (!options.diffAccess) throw new RacpError("CAPABILITY_UNAVAILABLE", "complete diff access is not configured");
      const body = await readJson(request);
      const offset = body.offset === undefined ? undefined : Number(body.offset);
      const limit = body.limit === undefined ? undefined : Number(body.limit);
      if ((offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))) throw new RacpError("INVALID_ARGUMENT", "invalid diff pagination");
      json(response, 200, await options.diffAccess.list(decodeURIComponent(diffListMatch[1]), { ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }));
      return;
    }
    const diffPatchMatch = /^\/v1\/sessions\/([^/]+)\/diff\/patch$/.exec(url.pathname);
    if (request.method === "POST" && diffPatchMatch) {
      checkCsrf(request, session);
      if (!options.diffAccess) throw new RacpError("CAPABILITY_UNAVAILABLE", "complete diff access is not configured");
      const body = await readJson(request);
      if (typeof body.path !== "string" || !body.path || body.path.length > 4096 || body.path.includes("\\") || body.path.includes("\0")) throw new RacpError("INVALID_ARGUMENT", "invalid diff path");
      const stream = await options.diffAccess.patch(decodeURIComponent(diffPatchMatch[1]), body.path);
      stream.once("error", () => { if (!response.headersSent) json(response, 503, { error: { code: "AGENT_UNAVAILABLE", message: "diff is unavailable" } }); else response.destroy(); });
      response.once("close", () => { if (!response.writableEnded) stream.destroy(); });
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${encodeURIComponent(body.path)}.patch"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      stream.pipe(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions") {
      const records = await options.listSessions();
      json(response, 200, { sessions: records.map((record) => options.agentHost.describeSession(record)) });
      return;
    }
    const match = /^\/v1\/sessions\/([^/]+?)(:attach|\/history|\/events|\/snapshot)?$/.exec(url.pathname);
    if (!match) throw new RacpError("FORBIDDEN", "unsupported companion operation");
    const sessionId = decodeURIComponent(match[1]);
    if (request.method === "POST" && match[2] === ":attach") {
      checkCsrf(request, session);
      const attached = await options.agentHost.attach(session.principal, { sessionId, role: options.operations ? "controller" : "viewer", includeSnapshot: true });
      json(response, 200, { ...attached, snapshot: projectSnapshot(attached.snapshot, session) });
      return;
    }
    if (request.method !== "GET") throw new RacpError("FORBIDDEN", "unsupported companion operation");
    if (match[2] === "/history") {
      const beforeItemId = request.headers["x-pi-history-before"];
      if (beforeItemId && (typeof beforeItemId !== "string" || beforeItemId.length > 256)) {
        throw new RacpError("INVALID_ARGUMENT", "invalid history cursor");
      }
      json(response, 200, await options.agentHost.history(session.principal, { sessionId, limit: 200, ...(beforeItemId ? { beforeItemId } : {}) }));
      return;
    }
    if (match[2] === "/snapshot") {
      const attached = await options.agentHost.attach(session.principal, { sessionId, role: "viewer", includeSnapshot: true });
      json(response, 200, projectSnapshot(attached.snapshot, session));
      return;
    }
    if (match[2] !== "/events") {
      const summary = (await options.listSessions()).find((record) => record.id === sessionId);
      if (!summary) throw new RacpError("NOT_FOUND", "session was not found");
      json(response, 200, { session: options.agentHost.describeSession(summary) });
      return;
    }
    // Attach checks existence before creating a stream. An unknown session must
    // not manufacture an EventHub stream or leak a subscription.
    await options.agentHost.attach(session.principal, { sessionId, role: "viewer", includeSnapshot: false });
    if (session.streams.size >= 4) throw new RacpError("RATE_LIMITED", "too many event streams");
    const cursorHeader = request.headers["last-event-id"];
    const after = parseCursor(typeof cursorHeader === "string" ? cursorHeader : undefined);
    response.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    session.streams.add(response);
    let subscriptionId: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearInterval(heartbeat);
      session.streams.delete(response);
      if (subscriptionId) options.agentHost.unsubscribe(subscriptionId, sessionId);
    };
    response.once("close", cleanup);
    const subscription = options.agentHost.subscribe(session.principal, { scope: "session", sessionId, after, maxOutstanding: 10_001 }, {
      deliver(event) {
        if (response.destroyed || response.writableEnded) return;
        if (response.writableLength > 256_000) { response.end(); return; }
        const id = typeof event.sequence === "number" ? `id: ${event.epoch}:${event.sequence}\n` : "";
        response.write(`${id}event: racp\ndata: ${JSON.stringify(projectEvent(event, session))}\n\n`);
        if (subscriptionId && typeof event.sequence === "number") options.agentHost.ack(subscriptionId, event.sequence);
      },
      close() { response.end(); },
    });
    subscriptionId = subscription.subscriptionId;
    if (response.destroyed || response.writableEnded) { cleanup(); return; }
    // Replay delivery is synchronous, so acknowledge the retained window after
    // the subscription id is available too.
    options.agentHost.ack(subscriptionId, subscription.starting.sequence - 1);
    if (!subscription.replayComplete) response.write(`event: resync\ndata: {}\n\n`);
    heartbeat = setInterval(() => {
      if (session.expires <= now()) { drop(key); return; }
      response.write(": heartbeat\n\n");
    }, 20_000);
    heartbeat.unref();
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof RequestBodyTimeoutError) {
        response.shouldKeepAlive = false;
        response.setHeader("Connection", "close");
        response.once("finish", () => request.destroy());
        json(response, 408, { error: { code: "REQUEST_TIMEOUT", message: "request body timed out" } });
        return;
      }
      const code = error instanceof RacpError ? error.code : "AGENT_UNAVAILABLE";
      const status = code === "REMOTE_AUTH_FAILED" ? 401 : code === "NOT_FOUND" ? 404 : code === "RATE_LIMITED" ? 429 : code === "CONFLICT" || code === "REVISION_CONFLICT" ? 409 : code === "PAYLOAD_TOO_LARGE" ? 413 : code === "INVALID_ARGUMENT" ? 400 : code === "AGENT_UNAVAILABLE" ? 503 : 403;
      if (!(error instanceof RacpError)) options.log("mobile read failed");
      json(response, status, { error: { code, message: error instanceof RacpError ? error.message : "the desktop is unavailable" } });
    });
  });
  // readJson applies the ordinary 10 second body gate. The outer HTTP cap is
  // longer only so admitted uploads can use their explicit five minute gate.
  server.requestTimeout = UPLOAD_BODY_TIMEOUT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mobile listener address unavailable");
  loopbackAuthority = `127.0.0.1:${address.port}`;
  if (!origin) origin = `http://${loopbackAuthority}`;
  return {
    origin,
    port: address.port,
    /** Delivered only to the trusted desktop setup surface; never logged. */
    get pairing() { return browserAuth.getPairing(); },
    getPairing:browserAuth.getPairing,
    issuePairing:browserAuth.issuePairing,
    listBrowsers:browserAuth.listBrowsers,
    revokeBrowser(id: string) {
      const revoked = browserAuth.revokeBrowser(id);
      if (revoked) cancelUploads(id);
      return revoked;
    },
    async close() {
      if (closed) return;
      closed = true;
      cancelUploads();
      browserAuth.close();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

/** Backward-compatible name for existing desktop bootstrap callers. */
export const startReadonlyMobile = startMobileCompanion;
