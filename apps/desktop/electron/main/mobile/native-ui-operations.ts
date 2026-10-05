import { realpath, readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { RacpError, type AgentHost, type Principal, type PersonalBrowserAuthority } from "@pi-desktop/agent-host";
import { readOpenableFile, readOpenableImage, imageMimeFor, type HostRpc } from "@pi-desktop/host-runtime";
import { loadComposerTemplates } from "@pi-desktop/agent-runtime";
import {
  IPC, KEYBOARD_SHORTCUT_IDS, THINKING_LEVELS,
  type ComposerCommand, type PlanProposal, type PlanResolveRequest,
  type RacpPermissionMode, type SessionDetail, type UiMessage,
  type AgentStatus, type AgentPromptAttachment,
} from "@pi-desktop/shared";
import { listDir } from "@pi-desktop/host-runtime";
import type { MobileUploadStore } from "./uploads";
import { builtinComposerCommands } from "../builtin-commands";
import { getWorkspaceFileIndex } from "../fs-index";
import { isChatRefOutsideRoots, parseChatRef, resolveChatFileRef } from "../chat-ref-resolve";
import { reviewChangesFromMessages } from "../../../src/lib/workspace-review";

export const NATIVE_UI_OPERATIONS = [
  "ui/bootstrap", "ui/session/get", "ui/session/collaboration", "ui/todos/get",
  "ui/plans/pending", "ui/plans/resolve", "ui/composer/commands", "ui/composer/execute",
  "ui/fs/index", "ui/fs/resolve", "ui/fs/read", "ui/fs/image",
  "ui/revision/save", "ui/revision/list", "ui/revision/activate", "ui/messages/replace",
  "ui/workspace/rollback",
  "ui/session/list", "ui/session/create", "ui/session/configure", "ui/session/title",
  "ui/session/fork", "ui/session/status", "ui/turn/prompt", "ui/queue/push", "ui/queue/list", "ui/queue/reorder",
  "ui/interactive/pending", "ui/input/respond", "ui/fs/attach", "ui/fs/list",
  "ui/project/read", "ui/prompt/enhance",
] as const;
export type NativeUiOperation = (typeof NATIVE_UI_OPERATIONS)[number];
export type NativeUiAuthority = { maxPermissionMode: RacpPermissionMode; principal?: Principal; authority?: PersonalBrowserAuthority };
export type MobileNativeUiOptions = {
  getHost: () => HostRpc | null;
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  agentHost?: AgentHost;
  isSessionBusy?: (sessionId: string) => boolean;
  dataDir: string;
  uploadStore?: MobileUploadStore;
  /** Main-private session-scoped command service; never a browser callback. */
  getComposerCommands?: (projectRoot: string | null) => Promise<ComposerCommand[]>;
};

const permissionModes = ["ask", "accept-edits", "auto"] as const;
const settingKeys = ["defaultProviderId", "defaultModelId", "defaultMode", "defaultPermissionMode", "enterToSend", "largePasteThreshold", "smoothStreaming", "thinkingDisplayMode", "contextUsageDisplay", "chatContentMaxWidth", "theme", "language", "fontFamily", "fontScale"];
const providerKeys = ["id", "name", "vendorKey", "type", "protocol", "enabled", "authKind", "hasSecret", "hasOauth", "oauthAccountLabel", "defaultModelId", "apiStyle", "supportsReasoning", "supportsVision", "contextWindow", "maxOutputTokens", "temperature", "createdAt", "updatedAt"];
const bindingKeys = ["id", "alias", "contextWindow", "contextWindowSource", "maxTokens", "maxTokensSource", "defaultThinkingLevel", "thinkingProtocol", "supportsImages", "supportsDocuments", "availableForSubagents", "nativeWebSearch"];
const modelKeys = ["modelId", "displayName", "providerId", "description", "family", "attachment", "reasoning", "thinkingProtocol", "toolCall", "structuredOutput", "temperature", "knowledge", "releaseDate", "lastUpdated", "openWeights", "status", "contextWindow", "maxTokens", "source", "catalogSource"];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RacpError("INVALID_ARGUMENT", "an object is required");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = object(value);
  if (Object.keys(input).some(key => !keys.includes(key))) throw new RacpError("INVALID_ARGUMENT", "unknown request field");
  return input;
}
function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new RacpError("INVALID_ARGUMENT", `invalid ${field}`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new RacpError("INVALID_ARGUMENT", `invalid ${field}`);
  return value as number;
}
function projectContainment(root: string, path: string): boolean {
  const value = relative(root, path);
  return !value || (!isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\"));
}
function primitives(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap(key => {
    const item = value[key];
    return item === null || ["string", "boolean", "number"].includes(typeof item) ? [[key, item]] : [];
  }));
}
function publicModel(value: unknown): Record<string, unknown> {
  const input = object(value); const result = primitives(input, modelKeys);
  for (const key of ["capabilities", "supportedThinkingLevels"]) if (Array.isArray(input[key])) result[key] = input[key].filter(item => typeof item === "string");
  if (input.modalities && typeof input.modalities === "object") {
    const modalities = object(input.modalities);
    result.modalities = Object.fromEntries(["input", "output"].flatMap(key => Array.isArray(modalities[key]) ? [[key, modalities[key].filter(item => typeof item === "string")]] : []));
  }
  if (input.thinkingLevelMap && typeof input.thinkingLevelMap === "object") result.thinkingLevelMap = primitives(object(input.thinkingLevelMap), THINKING_LEVELS);
  return result;
}
function publicProvider(value: unknown): Record<string, unknown> {
  const input = object(value);const result = primitives(input, providerKeys);
  result.models = Array.isArray(input.models) ? input.models.map(value => {const binding = object(value);const row = primitives(binding, bindingKeys);row.thinkingLevels = Array.isArray(binding.thinkingLevels) ? binding.thinkingLevels.filter(level => (THINKING_LEVELS as readonly unknown[]).includes(level)) : [];return row;}) : [];
  result.supportedThinkingLevels = Array.isArray(input.supportedThinkingLevels) ? input.supportedThinkingLevels.filter(level => (THINKING_LEVELS as readonly unknown[]).includes(level)) : [];
  return result;
}

/** Fixed UI operations preserve the original React API shapes, with session scope. */
export function createMobileNativeUiOperations(options: MobileNativeUiOptions) {
  function host(): HostRpc {
    const value = options.getHost();if (!value) throw new RacpError("AGENT_UNAVAILABLE", "host-core is unavailable");return value;
  }
  async function session(sessionId: string, full = false): Promise<SessionDetail> {
    const result = await host().call<{ session: SessionDetail | null }>("session.get", {id:sessionId,...(full ? {} : {messageLimit:1})});
    if (!result.session) throw new RacpError("NOT_FOUND", "session not found");return result.session;
  }
  async function projectRoot(detail: SessionDetail): Promise<string | null> {
    if (!detail.projectPath) return null;
    const listed = await host().call<{projects:Array<{path:string}>}>("projects.list",{});
    const requested = resolve(detail.projectPath);
    if (!listed.projects.some(project => resolve(project.path) === requested)) throw new RacpError("REMOTE_PATH_FORBIDDEN", "session project is not registered");
    return realpath(requested);
  }
  async function scratchRoot(sessionId: string): Promise<string> {
    if (/[\\/]/.test(sessionId) || sessionId === "." || sessionId === "..") throw new RacpError("INVALID_ARGUMENT", "invalid session identity");
    const result = await host().call<{path:string}>("session.getScratchPath",{sessionId});
    const expected = resolve(options.dataDir,"scratch",sessionId);const requested = resolve(result.path);
    if (requested !== expected || !projectContainment(resolve(options.dataDir,"scratch"),requested)) throw new RacpError("REMOTE_PATH_FORBIDDEN", "invalid session scratch root");
    // An empty temporary task has a Host-owned scratch identity before files exist.
    const canonical = await realpath(requested).catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return null;throw error;});
    if (canonical) {const root = await realpath(resolve(options.dataDir,"scratch"));if (!projectContainment(root,canonical)) throw new RacpError("REMOTE_PATH_FORBIDDEN", "scratch root leaves the session store");}
    return canonical ?? requested;
  }
  async function scoped(sessionId: string, mutation = false, full = false) {
    const detail = await session(sessionId,full);const project = await projectRoot(detail);
    if (mutation) {
      if (options.isSessionBusy?.(sessionId) || options.agentHost?.observeWorkTarget(sessionId).activeTurnId) throw new RacpError("CONFLICT", "session has an active turn");
      if (!project) await scratchRoot(sessionId);
    }
    return {detail,project};
  }
  async function resolveFile(sessionId: string, raw: unknown) {
    const ref = text(raw,"ref",512);const {detail,project} = await scoped(sessionId,false,true);
    const owned = detail.messages.some(message => message.attachments?.some(attachment => attachment.ref === ref));
    const parsed = parseChatRef(ref);
    if (!parsed || /^(?:file|https?):/i.test(ref) || (!owned && /^attachments[\\/]/i.test(ref))) throw new RacpError("REMOTE_PATH_FORBIDDEN", "file reference is outside the session");
    const scratch = await scratchRoot(sessionId);
    const attachments = owned ? join(options.dataDir,"attachments") : null;
    const roots={project:project ? [{path:project,name:basename(project),primary:true}] : [],scratch,attachments};
    if(await isChatRefOutsideRoots(ref,roots))throw new RacpError("REMOTE_PATH_FORBIDDEN","file reference is outside the session");
    const match = await resolveChatFileRef(ref,roots);
    return {match,project,scratch,attachments};
  }
  function checkMessages(value: unknown, detail: SessionDetail, allowUserEdit: boolean): UiMessage[] {
    if (!Array.isArray(value) || value.length > 10000 || Buffer.byteLength(JSON.stringify(value),"utf8") > 8 * 1024 * 1024) throw new RacpError("INVALID_ARGUMENT", "invalid message sequence");
    const byId = new Map(detail.messages.map((message,index) => [message.id,{message,index}]));let previous = -1;
    return value.map(value => {
      const row = object(value);const id = text(row.id,"message id");const trusted = byId.get(id);
      if (!trusted || trusted.index <= previous) throw new RacpError("FORBIDDEN", "messages must belong to this session in original order");previous = trusted.index;
      if (allowUserEdit && trusted.message.role === "user") {
        const mutable = new Set(["content","command","attachments"]);
        if (Object.keys(row).some(key => !mutable.has(key) && !isDeepStrictEqual(row[key],(trusted.message as unknown as Record<string,unknown>)[key]))) throw new RacpError("FORBIDDEN", "only user text may be edited");
        const content = typeof row.content === "string" ? row.content : trusted.message.content;
        if (Buffer.byteLength(content,"utf8") > 256 * 1024 || (row.command !== undefined && typeof row.command !== "string")) throw new RacpError("INVALID_ARGUMENT", "invalid user text");
        let attachments = trusted.message.attachments;
        if (row.attachments !== undefined) {
          if (!Array.isArray(row.attachments)) throw new RacpError("INVALID_ARGUMENT", "invalid attachment list");
          const seen = new Set<string>();
          attachments = row.attachments.map(value => {
            const item = object(value);const ref = text(item.ref,"attachment ref",4096);const owned = trusted.message.attachments?.find(attachment => attachment.ref === ref);
            if (!owned || seen.has(ref) || !isDeepStrictEqual(item,owned)) throw new RacpError("FORBIDDEN", "attachment must already belong to this user message");
            seen.add(ref);return owned;
          });
        }
        return {...trusted.message,content,...(row.command !== undefined ? {command:row.command as string} : {}),...(attachments !== undefined ? {attachments} : {})};
      }
      if (!isDeepStrictEqual(row,trusted.message)) throw new RacpError("FORBIDDEN", "model and tool messages cannot be rewritten");
      return trusted.message;
    });
  }
  function revisionRoot(detail: SessionDetail, value: unknown) {
    const rootId = text(value,"rootUserId");const index = detail.messages.findIndex(message => message.role === "user" && (message.id === rootId || message.revisionRootId === rootId));
    if (index < 0) throw new RacpError("NOT_FOUND", "revision root is not in this session");return {rootId,index};
  }
  function actor(context: NativeUiAuthority): Principal {
    if (!context.principal) throw new RacpError("FORBIDDEN", "browser identity is required");
    return context.principal;
  }
  function validateConfig(input: Record<string,unknown>, context: NativeUiAuthority) {
    if (input.mode !== undefined && !["agent","plan","goal"].includes(String(input.mode))) throw new RacpError("INVALID_ARGUMENT", "invalid mode");
    if (input.thinkingLevel !== undefined && input.thinkingLevel !== "omit" && !(THINKING_LEVELS as readonly unknown[]).includes(input.thinkingLevel)) throw new RacpError("INVALID_ARGUMENT", "invalid thinking level");
    for (const key of ["providerId","modelId"]) if(input[key] !== undefined) text(input[key],key,512);
    if (input.permissionMode !== undefined) {
      const mode=permissionModes.indexOf(input.permissionMode as RacpPermissionMode);
      if(mode<0 || mode>permissionModes.indexOf(context.maxPermissionMode)) throw new RacpError("FORBIDDEN", "permission mode exceeds browser authority");
      if(mode>0 && (context.authority?.principalSubject!==context.principal?.subject || context.authority?.kind!=="personal-browser")) throw new RacpError("FORBIDDEN", "personal task authorization is required");
    }
  }
  function queueSummary(entry: ReturnType<AgentHost["queueEntries"]>[number]) {
    return {id:entry.turn.id,sessionId:entry.turn.sessionId,content:entry.content,position:entry.turn.queuePosition??0,createdAt:entry.turn.startedAt??new Date().toISOString(),...(entry.userMessageId?{userMessageId:entry.userMessageId}:{}),...(entry.attachments?{attachments:entry.attachments}:{}),...(entry.priority!==undefined?{priority:entry.priority}:{})};
  }
  return {
    async dispatch(name: string, value: unknown, authority: NativeUiAuthority = {maxPermissionMode:"ask"}): Promise<unknown> {
      if (!(NATIVE_UI_OPERATIONS as readonly string[]).includes(name)) throw new RacpError("FORBIDDEN", "UI operation is not available");
      const input = object(value);
      if(name==="ui/project/read") {
        exact(input,["path"]);const path=text(input.path,"path",4096);const listed=await host().call<{projects:Array<{path:string;name?:string}>}>("projects.list",{});
        const project=listed.projects.find(project=>resolve(project.path)===resolve(path));if(!project)throw new RacpError("REMOTE_PATH_FORBIDDEN","project is not registered");
        return {workspace:{path:project.path,name:project.name||basename(project.path)}};
      }
      if(name==="ui/prompt/enhance") {
        exact(input,["sessionId","draft","providerId","modelId","thinkingLevel"]);if(input.sessionId)await session(text(input.sessionId,"sessionId"));
        const draft=text(input.draft,"draft",256*1024);if(draft.trim().startsWith("/"))throw new RacpError("INVALID_ARGUMENT","slash commands cannot be enhanced");validateConfig(input,authority);
        return options.invoke(IPC.invoke.promptEnhance,[input]);
      }
      if(name==="ui/session/list") {exact(input,[]);return options.invoke(IPC.invoke.sessionList,[]);}
      if(name==="ui/session/create") {
        exact(input,["title","mode","thinkingLevel","permissionMode","providerId","modelId","projectPath"]);validateConfig(input,authority);
        if(input.title!==undefined)text(input.title,"title",512);
        if(input.projectPath) {
          const path=text(input.projectPath,"projectPath",4096);const listed=await host().call<{projects:Array<{path:string}>}>("projects.list",{});
          if(!listed.projects.some(project=>resolve(project.path)===resolve(path)))throw new RacpError("REMOTE_PATH_FORBIDDEN","project is not registered");
        }
        const result=object(await options.invoke(IPC.invoke.sessionCreate,[{...input,permissionMode:input.permissionMode??"ask"}]));
        const created=object(result.session);const sessionId=text(created.id,"sessionId");
        // Host defaults may inherit auto. Explicitly bind newly created browser tasks.
        return options.invoke(IPC.invoke.sessionConfigure,[sessionId,{mode:input.mode??created.mode??"agent",permissionMode:input.permissionMode??"ask"}]);
      }
      if(name==="ui/session/configure") {
        exact(input,["sessionId","mode","thinkingLevel","permissionMode","providerId","modelId"]);validateConfig(input,authority);
        const sessionId=text(input.sessionId,"sessionId");const {detail}=await scoped(sessionId,true);const {sessionId:_id,...config}=input;
        return options.invoke(IPC.invoke.sessionConfigure,[sessionId,{...config,mode:config.mode??detail.mode}]);
      }
      if(name==="ui/session/title") {
        exact(input,["sessionId","userPrompt","providerId","modelId"]);await session(text(input.sessionId,"sessionId"));text(input.userPrompt,"userPrompt",256*1024);validateConfig(input,authority);
        return options.invoke(IPC.invoke.sessionSummarizeTitle,[input]);
      }
      if(name==="ui/session/fork") {
        exact(input,["sessionId","title","throughMessageId"]);const sessionId=text(input.sessionId,"sessionId");const {detail}=await scoped(sessionId,false,true);
        if(input.throughMessageId!==undefined&&!detail.messages.some(message=>message.id===input.throughMessageId))throw new RacpError("NOT_FOUND","fork boundary is not in the session");
        if(input.title!==undefined)text(input.title,"title",512);return options.invoke(IPC.invoke.sessionFork,[input]);
      }
      if(name==="ui/session/status") {exact(input,["sessionId"]);const sessionId=text(input.sessionId,"sessionId");await session(sessionId);return options.invoke(IPC.invoke.agentGetStatus,[sessionId]) as Promise<{status:AgentStatus}>;}
      if(name==="ui/turn/prompt"||name==="ui/queue/push") {
        exact(input,["sessionId","content","messageId","attachments","truncateFromMessageId"]);const sessionId=text(input.sessionId,"sessionId");const content=text(input.content,"content",256*1024);const principal=actor(authority);const agent=options.agentHost;
        if(!agent)throw new RacpError("AGENT_UNAVAILABLE","agent host is unavailable");
        await session(sessionId);
        const userMessageId=input.messageId===undefined?undefined:text(input.messageId,"messageId");
        if(userMessageId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userMessageId))throw new RacpError("INVALID_ARGUMENT","message identity must be a UUID");
        const boundary=input.truncateFromMessageId===undefined?undefined:text(input.truncateFromMessageId,"truncateFromMessageId");
        if(boundary) {if(name==="ui/queue/push")throw new RacpError("INVALID_ARGUMENT","history edits cannot be queued");const {detail}=await scoped(sessionId,true,true);if(!detail.messages.some(message=>message.id===boundary))throw new RacpError("NOT_FOUND","history boundary is not in the session");}
        let attachments:AgentPromptAttachment[]|undefined;
        if(input.attachments!==undefined) {if(!Array.isArray(input.attachments)||!options.uploadStore)throw new RacpError("INVALID_ARGUMENT","invalid attachments");attachments=await options.uploadStore.resolve(principal,sessionId,input.attachments);}
        const params={sessionId,input:{text:content,...(userMessageId?{userMessageId}:{}),...(attachments?{attachments}:{})},...(boundary?{truncateFromMessageId:boundary}:{}),context:{requestId:crypto.randomUUID()}};
        const result=name==="ui/queue/push"?await agent.enqueueTurn(principal,params,authority.authority):await agent.startTurn(principal,params,authority.authority);
        if(name==="ui/queue/push") {const entry=agent.queueEntries(sessionId).find(entry=>entry.turn.id===result.turn.id);return entry?queueSummary(entry):{id:result.turn.id,sessionId,content,position:0,createdAt:new Date().toISOString()};}
        return {accepted:true,turnId:result.turn.id};
      }
      if(name==="ui/queue/list") {exact(input,["sessionId"]);const sessionId=text(input.sessionId,"sessionId");await session(sessionId);if(!options.agentHost)throw new RacpError("AGENT_UNAVAILABLE","agent host is unavailable");return {entries:options.agentHost.queueEntries(sessionId).map(queueSummary)};}
      if(name==="ui/queue/reorder") {exact(input,["turnId","direction"]);if(input.direction!=="up"&&input.direction!=="down")throw new RacpError("INVALID_ARGUMENT","invalid direction");if(!options.agentHost)throw new RacpError("AGENT_UNAVAILABLE","agent host is unavailable");return options.agentHost.reorderTurn(actor(authority),text(input.turnId,"turnId"),input.direction);}
      if(name==="ui/interactive/pending") {exact(input,["sessionId"]);const sessionId=text(input.sessionId,"sessionId");await session(sessionId);return options.invoke(IPC.invoke.pendingInteractive,[{sessionId}]);}
      if(name==="ui/input/respond") {
        exact(input,["sessionId","requestId","answers"]);const sessionId=text(input.sessionId,"sessionId");await session(sessionId);const agent=options.agentHost;if(!agent)throw new RacpError("AGENT_UNAVAILABLE","agent host is unavailable");
        const entry=agent.pendingInputRequests(sessionId).find(entry=>entry.original.requestId===input.requestId);if(!entry)throw new RacpError("NOT_FOUND","question is no longer pending");
        if(!Array.isArray(input.answers)||input.answers.some(answer=>answer!==null&&(!Array.isArray(answer)||answer.some(value=>typeof value!=="string"))))throw new RacpError("INVALID_ARGUMENT","invalid answers");
        return agent.respondInput(actor(authority),{inputId:entry.input.id,answers:input.answers as Array<string[]|null>,context:{requestId:crypto.randomUUID()}});
      }
      if(name==="ui/fs/attach") {
        exact(input,["sessionId","ref"]);const sessionId=text(input.sessionId,"sessionId");const {match}=await resolveFile(sessionId,input.ref);if(!match||!options.uploadStore)throw new RacpError("NOT_FOUND","attachment is unavailable");
        const info=await stat(match.absolutePath);if(!info.isFile()||info.size>10*1024*1024)throw new RacpError("PAYLOAD_TOO_LARGE","attachment exceeds 10 MiB");
        const bytes=await readFile(match.absolutePath);return options.uploadStore.upload(actor(authority),sessionId,{name:basename(match.absolutePath),mimeType:imageMimeFor(match.absolutePath)??"application/octet-stream",data:bytes.toString("base64")});
      }
      if(name==="ui/fs/list") {
        exact(input,["sessionId","path"]);const sessionId=text(input.sessionId,"sessionId");const {project}=await scoped(sessionId);const root=project??await scratchRoot(sessionId);
        const raw=typeof input.path==="string"?input.path:"";const path=isAbsolute(raw)?relative(root,raw):raw;
        if(isAbsolute(path)||path===".."||path.startsWith("..\\")||path.startsWith("../"))throw new RacpError("REMOTE_PATH_FORBIDDEN","directory is outside the session");
        return {entries:await listDir(root,path)};
      }
      if (name === "ui/bootstrap") {
        exact(input,[]);
        const [providerResult,stored] = await Promise.all([options.invoke(IPC.invoke.providersList,[]),options.invoke(IPC.invoke.settingsGet,[])]);
        const providers = (object(providerResult).providers as unknown[]).map(publicProvider);
        const providerModels: Record<string,unknown[]> = {};
        await Promise.all(providers.map(async provider => {
          const result = await options.invoke(IPC.invoke.providersListModels,[{providerId:provider.id,source:"cache"}]);
          providerModels[String(provider.id)] = (object(result).models as unknown[]).map(publicModel);
        }));
        const settings = primitives(object(stored),settingKeys);
        if (object(stored).keybindings && typeof object(stored).keybindings === "object") settings.keybindings = primitives(object(object(stored).keybindings),KEYBOARD_SHORTCUT_IDS);
        const listed=await host().call<{projects:Array<{path:string;name?:string}>}>("projects.list",{});
        return {providers,providerModels,settings,projects:listed.projects.map(project=>({path:project.path,name:project.name||basename(project.path)}))};
      }
      if (name === "ui/session/get") {
        exact(input,["sessionId","messageBefore","messageAround","messageLimit","contentLimit"]);const sessionId = text(input.sessionId,"sessionId");await session(sessionId);
        const request: Record<string,unknown> = {id:sessionId};
        if (input.messageBefore !== undefined) request.messageBefore = integer(input.messageBefore,"messageBefore",0,Number.MAX_SAFE_INTEGER);
        if (input.messageAround !== undefined) request.messageAround = text(input.messageAround,"messageAround");
        if (input.messageLimit !== undefined) request.messageLimit = integer(input.messageLimit,"messageLimit",1,10000);
        if (input.contentLimit !== undefined) request.contentLimit = integer(input.contentLimit,"contentLimit",1,8*1024*1024);
        return options.invoke(IPC.invoke.sessionGet,[request]);
      }
      if (["ui/session/collaboration","ui/todos/get","ui/plans/pending"].includes(name)) {
        exact(input,["sessionId"]);const sessionId = text(input.sessionId,"sessionId");await session(sessionId);
        const channel = name === "ui/todos/get" ? IPC.invoke.todosGet : name === "ui/plans/pending" ? IPC.invoke.plansPending : IPC.invoke.sessionCollaboration;
        return options.invoke(channel,[{sessionId}]);
      }
      if (name === "ui/plans/resolve") {
        exact(input,["proposalId","sessionId","turnId","toolCallId","version","action","targetPermissionMode"]);
        const sessionId = text(input.sessionId,"sessionId");const scope = await scoped(sessionId);if (!scope.project) await scratchRoot(sessionId);
        const proposalId = text(input.proposalId,"proposalId");const turnId = text(input.turnId,"turnId");const toolCallId = text(input.toolCallId,"toolCallId");
        const pending = object(await options.invoke(IPC.invoke.plansPending,[{sessionId}])).plans as PlanProposal[];
        const proposal = pending.find(proposal => proposal.id === proposalId && proposal.sessionId === sessionId && proposal.turnId === turnId && proposal.toolCallId === toolCallId && proposal.status === "pending");
        if (!proposal) throw new RacpError("APPROVAL_STALE", "proposal identity no longer matches");
        const version = input.version === undefined ? proposal.version : integer(input.version,"version",1,Number.MAX_SAFE_INTEGER);
        if (version !== proposal.version) throw new RacpError("APPROVAL_STALE", "proposal version changed");
        if (input.action !== "approve" && input.action !== "reject") throw new RacpError("INVALID_ARGUMENT", "invalid proposal action");
        if (input.action === "approve") {
          const mode = permissionModes.indexOf(input.targetPermissionMode as RacpPermissionMode);const cap = permissionModes.indexOf(authority.maxPermissionMode);
          if (mode < 0) throw new RacpError("INVALID_ARGUMENT", "target permission mode is required");
          if (cap < 0 || mode > cap) throw new RacpError("FORBIDDEN", "proposal exceeds browser authority");
        } else if (input.targetPermissionMode !== undefined) throw new RacpError("INVALID_ARGUMENT", "reject cannot change permissions");
        return options.invoke(IPC.invoke.plansResolve,[{...input,version} as PlanResolveRequest]);
      }
      if (name === "ui/composer/commands") {
        exact(input,["sessionId"]);const project=input.sessionId ? (await scoped(text(input.sessionId,"sessionId"))).project : null;
        let commands: ComposerCommand[];
        if (options.getComposerCommands) commands = await options.getComposerCommands(project);
        else {const {templates} = await loadComposerTemplates(project);commands = [...builtinComposerCommands(),...templates.map(template => ({name:template.name,kind:"template" as const,title:template.name,description:template.description,argumentHint:template.argumentHint,source:template.source}))];}
        return {commands:commands.filter(command => ["builtin","template","skill"].includes(command.kind)).map(command => primitives(command as unknown as Record<string,unknown>,["name","kind","title","description","argumentHint","source","id","skillId"]))};
      }
      if (name === "ui/composer/execute") {
        exact(input,["sessionId","commandId"]);const sessionId = text(input.sessionId,"sessionId");const command = text(input.commandId,"commandId");
        if (!["builtin.agent.compact","builtin.mode.agent","builtin.mode.plan","builtin.mode.goal"].includes(command)) throw new RacpError("FORBIDDEN", "command is not browser-safe");
        await scoped(sessionId,true);
        if (command === "builtin.agent.compact") return options.invoke(IPC.invoke.agentCompact,[{sessionId}]);
        return options.invoke(IPC.invoke.sessionConfigure,[sessionId,{mode:command.slice("builtin.mode.".length)}]);
      }
      if (name === "ui/fs/index") {
        exact(input,["sessionId","projectPath"]);
        let project=input.sessionId ? (await scoped(text(input.sessionId,"sessionId"))).project : null;
        if(!input.sessionId && input.projectPath) {
          const result=object(await this.dispatch("ui/project/read",{path:input.projectPath},authority));
          project=await realpath(text(object(result.workspace).path,"projectPath",4096));
        }
        return project ? getWorkspaceFileIndex(project) : {entries:[],truncated:false};
      }
      if (["ui/fs/resolve","ui/fs/read","ui/fs/image"].includes(name)) {
        exact(input,name === "ui/fs/resolve" ? ["sessionId","ref"] : ["sessionId","ref","mimeType"]);const sessionId = text(input.sessionId,"sessionId");
        const {match,project,scratch,attachments} = await resolveFile(sessionId,input.ref);
        if (name === "ui/fs/resolve") return {match};
        if (!match) throw new RacpError("NOT_FOUND", "file reference does not resolve");
        const mimeType = input.mimeType === undefined ? undefined : text(input.mimeType,"mimeType",128);const extras = [scratch,...(attachments ? [attachments] : [])];
        return name === "ui/fs/image" ? readOpenableImage(match.absolutePath,project,extras,mimeType) : readOpenableFile(match.absolutePath,project,extras,mimeType);
      }
      if (name === "ui/workspace/rollback") {
        exact(input,["sessionId","snapshotId"]);const sessionId = text(input.sessionId,"sessionId");const snapshotId = text(input.snapshotId,"snapshotId");const {detail} = await scoped(sessionId,true,true);
        if (!reviewChangesFromMessages(detail.messages).some(entry => entry.change.snapshotId === snapshotId)) throw new RacpError("FORBIDDEN", "review snapshot is not in this session");
        return options.invoke(IPC.invoke.workspaceReviewRollback,[{sessionId,snapshotId}]);
      }
      if (name === "ui/messages/replace") {
        exact(input,["sessionId","messages"]);const sessionId = text(input.sessionId,"sessionId");const {detail} = await scoped(sessionId,true,true);const messages = checkMessages(input.messages,detail,true);
        return options.invoke(IPC.invoke.sessionReplaceMessages,[{sessionId,messages}]);
      }
      if (name === "ui/revision/save") {
        exact(input,["sessionId","rootUserId","messages","makeActive"]);const sessionId = text(input.sessionId,"sessionId");const {detail} = await scoped(sessionId,true,true);const {rootId,index} = revisionRoot(detail,input.rootUserId);
        const messages = checkMessages(input.messages,detail,true);
        if (!messages.length || messages[0].id !== detail.messages[index].id || messages.some(message => detail.messages.indexOf(detail.messages.find(row => row.id === message.id)!) < index)) throw new RacpError("FORBIDDEN", "revision must start at its user root");
        if (input.makeActive !== undefined && typeof input.makeActive !== "boolean") throw new RacpError("INVALID_ARGUMENT", "invalid makeActive");
        return options.invoke(IPC.invoke.sessionSaveRevision,[{sessionId,rootUserId:rootId,messages,makeActive:input.makeActive === true}]);
      }
      if (name === "ui/revision/list" || name === "ui/revision/activate") {
        exact(input,name === "ui/revision/list" ? ["sessionId","rootUserId"] : ["sessionId","rootUserId","revisionIndex","prefix"]);const sessionId = text(input.sessionId,"sessionId");const {detail} = await scoped(sessionId,name === "ui/revision/activate",true);const {rootId,index} = revisionRoot(detail,input.rootUserId);
        if (name === "ui/revision/list") return options.invoke(IPC.invoke.sessionListRevisions,[{sessionId,rootUserId:rootId}]);
        const revisionIndex = integer(input.revisionIndex,"revisionIndex",1,Number.MAX_SAFE_INTEGER);const prefix = checkMessages(input.prefix,detail,false);
        if (!isDeepStrictEqual(prefix,detail.messages.slice(0,index))) throw new RacpError("FORBIDDEN", "revision prefix does not match the current transcript");
        return options.invoke(IPC.invoke.sessionActivateRevision,[{sessionId,rootUserId:rootId,revisionIndex,prefix}]);
      }
      throw new RacpError("FORBIDDEN", "UI operation is not available");
    },
  };
}
