import { randomBytes, randomInt } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  RacpError,
  type PersonalBrowserAuthority,
  type Principal,
} from "@pi-desktop/agent-host";
import { hashToken, hashesEqual, newPairingToken } from "@pi-desktop/racp";
import type {
  MobileBrowserAuthorizationStore,
  MobileBrowserCapabilities,
  PersistedBrowserAuthorization,
  PersonalBrowserTaskControl,
} from "./browser-authorization-store";

export const MOBILE_PAIRING_LIFETIME = 2 * 60_000;
export const MOBILE_SESSION_LIFETIME = 30 * 24 * 60 * 60_000;
export type MobilePairingRequest = {
  origin: string; label: string; userAgent: string; verificationCode: string;
  expiresAt: string; roles: readonly string[];
  /** Trusted local cancellation only; this request is never serialized to the browser. */
  signal?: AbortSignal;
};
export type MobilePairingDecision =
  | boolean
  | {
      approved: boolean;
      /** Present only when the native confirmation explicitly grants task control. */
      taskControl?: PersonalBrowserTaskControl;
    };
export type BrowserSession = {
  id: string; origin: string; label: string; createdAt: string; expires: number; csrf: string;
  principal: Principal; capabilities: MobileBrowserCapabilities;
  /** Main-private authority; never serialized into the browser session response. */
  authority?: PersonalBrowserAuthority;
  streams: Set<ServerResponse>;
};
type Pending = {
  secretHash: string; request: MobilePairingRequest; expires: number;
  abortController: AbortController;
  status: "pending" | "approved" | "rejected";
  capabilities: MobileBrowserCapabilities;
};
type CompletionReceipt = { secretHash: string; expires: number; sessionKey: string };
const secret = () => randomBytes(24).toString("base64url");
const cleanLabel = (value: string, limit: number) => value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g," ").trim().slice(0,limit);
const failed = () => new RacpError("PAIRING_FAILED","pairing is invalid, expired, or already used");

function pairingCapabilities(decision: MobilePairingDecision): {
  approved: boolean;
  capabilities: MobileBrowserCapabilities;
} {
  if (typeof decision === "boolean") return { approved: decision, capabilities: {} };
  if (!decision || typeof decision !== "object" || typeof decision.approved !== "boolean") {
    return { approved: false, capabilities: {} };
  }
  const taskControl = decision.taskControl;
  if (!taskControl) return { approved: decision.approved, capabilities: {} };
  if (
    !["ask", "accept-edits", "auto"].includes(taskControl.maxPermissionMode) ||
    typeof taskControl.allowSessionGrants !== "boolean"
  ) {
    return { approved: false, capabilities: {} };
  }
  return {
    approved: decision.approved,
    capabilities: {
      taskControl: {
        maxPermissionMode: taskControl.maxPermissionMode,
        allowSessionGrants: taskControl.allowSessionGrants,
      },
    },
  };
}

function browserAuthority(
  principalSubject: string,
  capabilities: MobileBrowserCapabilities,
): PersonalBrowserAuthority | undefined {
  const taskControl = capabilities.taskControl;
  return taskControl
    ? {
        kind: "personal-browser",
        principalSubject,
        maxPermissionMode: taskControl.maxPermissionMode,
        allowSessionGrants: taskControl.allowSessionGrants,
      }
    : undefined;
}

/** In-memory browser credentials. Only trusted desktop code can approve/revoke. */
export function createMobileBrowserAuth(options: {
  origin: () => string; roles: Principal["roles"]; now: () => number;
  confirmPairing?: (request: MobilePairingRequest) => Promise<MobilePairingDecision>;
  authorizationStore?: MobileBrowserAuthorizationStore;
}) {
  const sessions = new Map<string,BrowserSession>();
  const pending = new Map<string,Pending>();
  const completionReceipts = new Map<string,CompletionReceipt>();
  const attempts: number[] = [];
  let closed = false;
  let authorizationsLoaded = !options.authorizationStore;
  let pairing = {token:newPairingToken(),expires:options.now()+MOBILE_PAIRING_LIFETIME,consumed:false};
  function authorizationRecords(source = sessions): PersistedBrowserAuthorization[] {
    return [...source].map(([cookieHash,value]) => ({
      cookieHash,id:value.id,origin:value.origin,label:value.label,createdAt:value.createdAt,
      expiresAt:new Date(value.expires).toISOString(),roles:[...value.principal.roles],
      capabilities:value.capabilities,
    }));
  }
  function persist(source = sessions) { options.authorizationStore?.replace(authorizationRecords(source)); }
  function hydrate() {
    if (authorizationsLoaded) return;
    const origin = options.origin();
    if (!origin) return;
    authorizationsLoaded = true;
    for (const record of options.authorizationStore!.load()) {
      const expires = Date.parse(record.expiresAt);
      const roles = record.roles.filter(role => options.roles.includes(role));
      if (record.origin !== origin || expires <= options.now() || !roles.length) continue;
      const principalSubject = `mobile-browser-${record.id}`;
      sessions.set(record.cookieHash,{
        id:record.id,origin:record.origin,label:record.label,createdAt:record.createdAt,expires,csrf:secret(),
        principal:{subject:principalSubject,roles,pairedDevice:false},
        capabilities:record.capabilities,
        authority:browserAuthority(principalSubject,record.capabilities),
        streams:new Set(),
      });
    }
  }
  function endStreams(value: BrowserSession | undefined) { for (const stream of value?.streams ?? []) stream.end(); }
  function drop(key: string) {
    hydrate();
    const value = sessions.get(key); if (!value) return;
    const next = new Map(sessions); next.delete(key);
    persist(next);
    sessions.delete(key); endStreams(value);
  }
  function prune() {
    hydrate();
    let expired = false;
    for (const [key,value] of sessions) if (value.expires <= options.now()) { sessions.delete(key); endStreams(value); expired = true; }
    if (expired) persist();
    for (const [key,value] of pending) if (value.expires <= options.now()) {
      pending.delete(key);
      value.abortController.abort();
    }
    for (const [key,value] of completionReceipts) if (value.expires <= options.now()) completionReceipts.delete(key);
  }
  function clearPending() {
    for (const value of pending.values()) value.abortController.abort();
    pending.clear();
  }
  const getPairing = () => ({origin:options.origin(),token:pairing.token,expiresAt:new Date(pairing.expires).toISOString()});
  return {
    getPairing,
    issuePairing() {
      if (closed) throw failed();
      clearPending();
      completionReceipts.clear();
      pairing = {token:newPairingToken(),expires:options.now()+MOBILE_PAIRING_LIFETIME,consumed:false};
      return getPairing();
    },
    begin(token: unknown, label: unknown, userAgent: string) {
      prune();
      while (attempts.length && attempts[0]! <= options.now()-60_000) attempts.shift();
      if (attempts.length >= 8) throw new RacpError("RATE_LIMITED","try pairing later");
      attempts.push(options.now());
      if (closed || pairing.consumed || pairing.expires <= options.now() || typeof token !== "string" || token.length > 256 || !hashesEqual(hashToken(token),hashToken(pairing.token))) throw failed();
      if (!options.confirmPairing) throw new RacpError("CAPABILITY_UNAVAILABLE","desktop pairing confirmation is unavailable");
      if (label !== undefined && (typeof label !== "string" || label.length > 256)) throw new RacpError("INVALID_ARGUMENT","invalid browser label");
      if (sessions.size >= 8) throw new RacpError("RATE_LIMITED","revoke an existing browser first");
      // Consume synchronously before starting a trusted asynchronous approval.
      pairing.consumed = true;
      const requestId = secret(); const completionSecret = secret();
      const pendingExpires = options.now()+MOBILE_PAIRING_LIFETIME;
      const abortController = new AbortController();
      const value: Pending = {secretHash:hashToken(completionSecret),expires:pendingExpires,abortController,status:"pending",capabilities:{},request:{origin:options.origin(),label:cleanLabel(typeof label === "string" ? label : "Mobile browser",64) || "Mobile browser",userAgent:cleanLabel(userAgent,160),verificationCode:String(randomInt(1_000_000)).padStart(6,"0"),expiresAt:new Date(pendingExpires).toISOString(),roles:[...options.roles],signal:abortController.signal}};
      pending.set(requestId,value);
      // Fail closed for thrown UI errors, cancellation, expiry, rotation and shutdown.
      void Promise.resolve().then(() => {
        if (pending.get(requestId) !== value || value.abortController.signal.aborted) return false;
        return options.confirmPairing!(value.request);
      }).then(decision => {
        if (!closed && pending.get(requestId) === value && value.expires > options.now()) {
          const resolved = pairingCapabilities(decision);
          value.status = resolved.approved ? "approved" : "rejected";
          value.capabilities = resolved.approved ? resolved.capabilities : {};
        }
      }).catch(() => { if (pending.get(requestId) === value) value.status = "rejected"; });
      return {requestId,secret:completionSecret,verificationCode:value.request.verificationCode,expiresAt:value.request.expiresAt,status:"pending" as const};
    },
    cancel(requestId: unknown, completionSecret: unknown) {
      prune();
      if (closed || typeof requestId !== "string" || requestId.length > 256 || typeof completionSecret !== "string" || completionSecret.length > 256) throw failed();
      const value = pending.get(requestId);
      const receipt = completionReceipts.get(requestId);
      const secretHash = hashToken(completionSecret);
      if (value) {
        if (!hashesEqual(secretHash,value.secretHash)) throw failed();
        pending.delete(requestId);
        value.abortController.abort();
      } else if (receipt) {
        if (!hashesEqual(secretHash,receipt.secretHash)) throw failed();
        drop(receipt.sessionKey);
        completionReceipts.delete(requestId);
      } else {
        throw failed();
      }
      return {status:"cancelled" as const};
    },
    complete(requestId: unknown, completionSecret: unknown) {
      prune();
      if (closed || typeof requestId !== "string" || requestId.length > 256 || typeof completionSecret !== "string" || completionSecret.length > 256) throw failed();
      const value = pending.get(requestId);
      if (!value || !hashesEqual(hashToken(completionSecret),value.secretHash)) throw failed();
      if (value.status === "pending") return {status:"pending" as const};
      pending.delete(requestId);
      if (value.status !== "approved") return {status:"rejected" as const};
      const cookie = secret(); const id = secret(); const createdAt = new Date(options.now()).toISOString();
      const principalSubject = `mobile-browser-${id}`;
      const session: BrowserSession = {id,origin:value.request.origin,label:value.request.label,createdAt,expires:options.now()+MOBILE_SESSION_LIFETIME,csrf:secret(),principal:{subject:principalSubject,roles:[...options.roles],pairedDevice:false},capabilities:value.capabilities,authority:browserAuthority(principalSubject,value.capabilities),streams:new Set()};
      const sessionKey = hashToken(cookie);
      const next = new Map(sessions); next.set(sessionKey,session);
      persist(next);
      sessions.set(sessionKey,session);
      completionReceipts.set(requestId,{secretHash:value.secretHash,expires:value.expires,sessionKey});
      return {status:"approved" as const,cookie,session};
    },
    authenticate(cookie: string | undefined) {
      prune();
      const key = cookie ? hashToken(cookie) : ""; const session = sessions.get(key);
      if (!session || session.origin !== options.origin() || session.expires <= options.now()) { if (session) drop(key); throw new RacpError("REMOTE_AUTH_FAILED","pair this browser again"); }
      return {key,session};
    },
    drop,
    listBrowsers() { prune();return [...sessions.values()].map(value => ({id:value.id,label:value.label,createdAt:value.createdAt,expiresAt:new Date(value.expires).toISOString(),capabilities:value.capabilities})); },
    revokeBrowser(id: string) { prune();for (const [key,value] of sessions) if (value.id === id) {drop(key);return true;} return false; },
    close() {closed = true;clearPending();completionReceipts.clear();for (const value of sessions.values()) endStreams(value);sessions.clear();},
  };
}
