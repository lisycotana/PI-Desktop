import { IPC, type AgentPromptRequest, type AgentPromptResponse, type AgentQueuePushRequest, type AppSettings, type ComposerPasteFile, type Result, type ToolPermissionResolution, type AskToolResolution } from "@pi-desktop/shared";
import { browserClient as client } from "./browser-client";
import { getBrowserSettings, saveBrowserSettings } from "./browser-settings";

const pickedFiles=new Map<string,File[]>();
const uploadedFiles=new Map<string,{id:string;sessionId:string;dataUrl?:string}>();
const listeners=new Map<string,Set<(...args:unknown[])=>void>>();
export function emitBrowserEvent(channel:string,payload:unknown) {listeners.get(channel)?.forEach(listener=>listener(payload));}
export function browserAttachmentReference(path:string) {return uploadedFiles.get(path);}

async function upload(sessionId:string,name:string,mimeType:string,data:string) {
  const result=await client.request<{id:string;name:string;kind:"file"|"image";mimeType:string}>("/v1/sessions/"+encodeURIComponent(sessionId)+"/attachments",{name,mimeType,data});
  const path="mobile-upload:"+result.id;
  uploadedFiles.set(path,{id:result.id,sessionId,...(result.kind==="image"?{dataUrl:`data:${result.mimeType};base64,${data}`}:{})});
  return {path,name:result.name,kind:result.kind,mimeType:result.mimeType};
}
async function uploadFiles(sessionId:string,files:ComposerPasteFile[]) {
  return {files:await Promise.all(files.map(async file=>upload(sessionId,file.name||"paste.txt",file.mimeType||"application/octet-stream",await fileBase64(new Blob([file.data])))))};
}
async function pickFiles() {
  const input=document.createElement("input");input.type="file";input.multiple=true;input.hidden=true;document.body.append(input);
  return new Promise<{token:string|null;canceled?:boolean}>(resolve=>{
    const finish=(canceled:boolean)=>{const files=[...(input.files||[])];input.remove();if(canceled||!files.length){resolve({token:null,canceled:true});return;}const token=crypto.randomUUID();pickedFiles.set(token,files);resolve({token});};
    input.addEventListener("change",()=>finish(false),{once:true});input.addEventListener("cancel",()=>finish(true),{once:true});input.click();
  });
}
function fileBase64(file:Blob):Promise<string> {return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});}
async function startPrompt(request:AgentPromptRequest & Partial<AgentQueuePushRequest>,queue=false):Promise<AgentPromptResponse> {
  const attachments=await Promise.all((request.attachments||[]).map(async ref=>{
    const uploaded=uploadedFiles.get(ref.path);if(uploaded&&uploaded.sessionId===request.sessionId)return {id:uploaded.id};
    const result=await client.native<{id:string}>("ui/fs/attach",{sessionId:request.sessionId,ref:ref.path});return {id:result.id};
  }));
  const messageId=queue?request.userMessageId:request.messageId;
  return client.native<AgentPromptResponse>(queue?"ui/queue/push":"ui/turn/prompt",{sessionId:request.sessionId,content:request.content,attachments,...(messageId?{messageId}:{}),...(request.truncateFromMessageId?{truncateFromMessageId:request.truncateFromMessageId}:{})});
}

/** A browser implementation of the existing renderer boundary. No channel crosses HTTP. */
async function invoke(channel:string,...args:unknown[]):Promise<unknown> {
  const input=(args[0]||{}) as AgentPromptRequest & ToolPermissionResolution & AskToolResolution & {id:string;token:string;files:ComposerPasteFile[];ref:string;path:string;mimeType:string};
  const sessionId=String(input.sessionId || client.sessionId);
  switch(channel) {
    case IPC.invoke.settingsGet: return getBrowserSettings();
    case IPC.invoke.settingsSet: return saveBrowserSettings(args[0] as AppSettings);
    case IPC.invoke.projectSet: {const result=await client.native("ui/project/read",{path:args[0]});client.projectPath=String(args[0]);return result;}
    case IPC.invoke.projectClear: client.projectPath="";return {ok:true};
    case IPC.invoke.appGetOnboarding: return {showChecklist:false,steps:[]};
    case IPC.invoke.sessionList: return client.native("ui/session/list");
    case IPC.invoke.sessionGet: {const {id,...window}=input;return client.native("ui/session/get",{...window,sessionId:id});}
    case IPC.invoke.sessionCreate: return client.native("ui/session/create",input);
    case IPC.invoke.sessionConfigure: return client.native("ui/session/configure",{sessionId:args[0],...(args[1] as object)});
    case IPC.invoke.sessionFork: return client.native("ui/session/fork",input);
    case IPC.invoke.sessionRename: await client.action("session/rename",{sessionId:args[0],title:args[1]});return {ok:true};
    case IPC.invoke.sessionDelete: return client.action("session/delete",{sessionId:args[0]});
    case IPC.invoke.sessionCollaboration: return client.native("ui/session/collaboration",input);
    case IPC.invoke.sessionSummarizeTitle: return client.native("ui/session/title",input);
    case IPC.invoke.agentPrompt: case IPC.invoke.agentSteer: return startPrompt(input as AgentPromptRequest);
    case IPC.invoke.agentQueuePush: return startPrompt(input,true);
    case IPC.invoke.agentQueueList: return client.native("ui/queue/list",input);
    case IPC.invoke.agentQueueRemove: return client.action("turn/cancel",input);
    case IPC.invoke.agentQueuePrioritize: return client.action("turn/prioritize",input);
    case IPC.invoke.agentQueueReorder: return client.native("ui/queue/reorder",input);
    case IPC.invoke.agentAbort: case IPC.invoke.agentStop: {
      const snapshot=await client.snapshot(sessionId);if(!snapshot.activeTurn)return {requested:false};
      await client.action(channel===IPC.invoke.agentStop?"turn/stop":"turn/interrupt",{turnId:snapshot.activeTurn.id});return {requested:true};
    }
    case IPC.invoke.agentGetStatus: return client.native("ui/session/status",{sessionId:String(args[0])});
    case IPC.invoke.agentCompact: return client.action("session/compact",input);
    case IPC.invoke.toolResolvePermission: {
      const snapshot=await client.snapshot(sessionId);const request=snapshot.pendingApprovals.find(r=>r.id===input.requestId);
      if(!request)throw new Error("Permission request is no longer pending");
      return client.action("approval/respond",{approvalId:request.id,decision:input.decision,context:{requestId:crypto.randomUUID(),expectedRevision:request.revision}});
    }
    case IPC.invoke.askToolResolve: return client.native("ui/input/respond",{sessionId:input.sessionId,requestId:input.requestId,answers:input.answers});
    case IPC.invoke.pendingInteractive: return client.native("ui/interactive/pending",input);
    case IPC.invoke.plansPending: return client.native("ui/plans/pending",input);
    case IPC.invoke.plansResolve: return client.native("ui/plans/resolve",input);
    case IPC.invoke.todosGet: return client.native("ui/todos/get",input);
    case IPC.invoke.promptEnhance: return client.native("ui/prompt/enhance",input);
    case IPC.invoke.composerCommands: return client.native("ui/composer/commands",{sessionId});
    case IPC.invoke.commandPaletteExecute: return client.native("ui/composer/execute",{sessionId,commandId:args[0]});
    case IPC.invoke.fsList: return client.native("ui/fs/list",{sessionId,path:input.path});
    case IPC.invoke.fsIndex: return client.native("ui/fs/index",{sessionId,...(!sessionId&&client.projectPath?{projectPath:client.projectPath}:{})});
    case IPC.invoke.fsResolveRef: return client.native("ui/fs/resolve",{...input,sessionId:input.sessionId||sessionId});
    case IPC.invoke.fsRead: {const uploaded=uploadedFiles.get(input.path);if(uploaded?.dataUrl)return {path:input.path,dataUrl:uploaded.dataUrl};return client.native("ui/fs/read",{sessionId,ref:input.path,mimeType:input.mimeType});}
    case IPC.invoke.fsReadImageDataUrl: {const uploaded=uploadedFiles.get(input.ref);if(uploaded?.dataUrl)return {dataUrl:uploaded.dataUrl};return client.native("ui/fs/image",{...input,sessionId:input.sessionId||sessionId});}
    case IPC.invoke.composerPickFiles: case IPC.invoke.composerPickPhotos: return pickFiles();
    case IPC.invoke.composerImportFiles: {const files=pickedFiles.get(input.token);if(!files)throw new Error("File selection expired");pickedFiles.delete(input.token);return uploadFiles(sessionId,await Promise.all(files.map(async file=>({name:file.name,mimeType:file.type||"application/octet-stream",data:await file.arrayBuffer()}))));}
    case IPC.invoke.composerPasteFiles: return uploadFiles(sessionId,input.files);
    case IPC.invoke.clipboardRecordPaste: return {ok:true};
    case IPC.invoke.sessionReplaceMessages: return client.native("ui/messages/replace",input);
    case IPC.invoke.sessionSaveRevision: return client.native("ui/revision/save",input);
    case IPC.invoke.sessionListRevisions: return client.native("ui/revision/list",input);
    case IPC.invoke.sessionActivateRevision: return client.native("ui/revision/activate",input);
    case IPC.invoke.workspaceReviewRollback: return client.native("ui/workspace/rollback",input);
    case IPC.invoke.workspaceDiff: return client.action("workspace/diff",{sessionId});
    case IPC.invoke.fsOpen: case IPC.invoke.fsReveal: return client.native("ui/fs/resolve",{sessionId,ref:input.path});
    default: throw new Error(`Browser operation unavailable: ${channel}`);
  }
}

export function installBrowserBridge() {
  window.piDesktop={channels:IPC,platform:"linux",locale:navigator.language,
    async invoke<T>(channel:string,...args:unknown[]):Promise<Result<T>> {
      try{return {ok:true,data:await invoke(channel,...args) as T};}
      catch(error){return {ok:false,error:{code:(error as {code?:string}).code||"INTERNAL",message:error instanceof Error?error.message:String(error)}};}
    },
    on(channel,listener) {const group=listeners.get(channel)||new Set();group.add(listener);listeners.set(channel,group);return ()=>{group.delete(listener);};},
  };
}
