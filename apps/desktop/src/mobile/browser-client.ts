import type { RacpSessionSnapshot } from "@pi-desktop/shared";

export class BrowserRequestError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

export const browserClient = {
  csrf: "",
  sessionId: "",
  projectPath: "",
  snapshots: new Map<string, RacpSessionSnapshot>(),
  onUnauthorized: () => {},
  async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin", cache: "no-store", signal,
      headers: { "X-PI-Origin": location.origin, ...(body === undefined ? {} : {"Content-Type":"application/json","X-PI-CSRF":this.csrf}) },
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    });
    const value = await response.json();
    if(!response.ok) {
      if(response.status===401 && this.csrf) {this.csrf="";this.onUnauthorized();}
      throw new BrowserRequestError(value.error?.message || value.message || response.statusText,value.error?.code || value.code || "INTERNAL");
    }
    return value as T;
  },
  native<T>(operation: string, input: unknown = {}) {
    return this.request<T>("/v1/native/"+operation,input);
  },
  action<T>(method: string, params: Record<string, unknown>) {
    return this.request<T>("/v1/action",{method,params:{...params,context:{requestId:crypto.randomUUID(),...(params.context as object || {})}}});
  },
  async snapshot(sessionId: string) {
    const value=await this.request<RacpSessionSnapshot>("/v1/sessions/"+encodeURIComponent(sessionId)+"/snapshot");
    this.snapshots.set(sessionId,value);return value;
  },
};
