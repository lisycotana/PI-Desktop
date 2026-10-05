import { register } from "node:module";
import { mkdir, writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IPC } from "@pi-desktop/shared";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "ts-import-hooks.mjs")));
const { mobileFixture } = await import("./mobile-fixture.mjs");
const { startMobileCompanion } = await import("../../electron/main/mobile/readonly-server.ts");
const { createOperations } = await import("../../electron/main/mobile/backend-operations.ts");
const { createMobileUploadStore } = await import("../../electron/main/mobile/uploads.ts");
const { createMobileSessionData } = await import("../../electron/main/mobile/session-data.ts");
const { createMobileDiffAccess } = await import("../../electron/main/mobile/diff-access.ts");
const { createMobileNativeUiOperations } = await import("../../electron/main/mobile/native-ui-operations.ts");
const { loadBrowserAssets } = await import("../../electron/main/mobile/browser-assets.ts");
const dataDir = await mkdtemp(join(tmpdir(), "pi-mobile-preview-"));
const projectPath = join(dataDir,"project"); await mkdir(projectPath);
await writeFile(join(projectPath,"example.txt"),"Example workspace file.\n");
execFileSync("git",["init","--quiet",projectPath]);
execFileSync("git",["-C",projectPath,"add","example.txt"]);
execFileSync("git",["-C",projectPath,"-c","user.name=PI preview","-c","user.email=preview@invalid","-c","commit.gpgsign=false","commit","--quiet","-m","Isolated fixture"]);
await writeFile(join(projectPath,"example.txt"),"Example workspace file.\nMobile layout follows PI Desktop.\n");
const f = mobileFixture({id:"123e4567-e89b-12d3-a456-426614174000",projectPath});
f.record.title = "移动端布局校验";
f.record.providerId = "preview";f.record.modelId = "sample";f.record.thinkingLevel = "high";
f.record.messages[0].content = "按 PI 桌面的布局核对手机界面，保留完整调用和文件更改。";
f.record.messages[1].content = "这是隔离的测试会话，用来检查页面布局和任务操作。\n\n- 模型与推理等级在输入框底部打开\n- 工具行展开后查看完整参数、结果\n- 文件更改在「审阅」中查看";
f.record.messages[1].thinking = "测试数据：这里演示模型接口实际返回的 thinking 字段，未生成或推测隐藏的内部思维链。";
f.record.messages[1].usage = {inputTokens:20000,outputTokens:1000,totalTokens:21000};
f.record.messages[1].providerId="preview";f.record.messages[1].modelId="sample";f.record.messages[1].status="complete";
f.record.messages.push({id:"preview-tool-read",role:"tool",content:"",createdAt:"2026-10-03T08:00:01Z",toolName:"Read",toolCallId:"preview-tool-read",toolArgs:{path:"example.txt"},toolResult:{content:"Example workspace file.\nMobile layout follows PI Desktop.\n"},toolStatus:"success",toolDurationMs:26});
f.record.messages.push({id:"preview-tool-write",role:"tool",content:"",createdAt:"2026-10-03T08:00:02Z",toolName:"Write",toolCallId:"preview-tool-write",toolArgs:{path:"example.txt",content:"Example workspace file.\nMobile layout follows PI Desktop.\n"},toolResult:{details:{root:"workspace",review:{version:1,snapshotId:"preview-change",messageId:"preview-tool-write",path:"example.txt",operation:"write",status:"modified",state:"active",additions:1,deletions:0,reversible:false,hunks:[{header:"@@ -1,1 +1,2 @@",lines:[{type:"context",text:"Example workspace file."},{type:"add",text:"Mobile layout follows PI Desktop."}]}]}}},toolStatus:"success",toolDurationMs:34});
f.record.messages.push({id:"preview-delegation",role:"tool",content:"",createdAt:"2026-10-03T08:00:02Z",toolName:"Task",toolCallId:"preview-delegation",toolStatus:"success",toolArgs:{agent:"explorer",description:"Check composer layout",prompt:"Inspect the input controls."},toolResult:{details:{delegationId:"preview-delegation",status:"completed"}}});
f.record.messages.push({id:"preview-delegate-answer",role:"assistant",content:"Original composer controls are present.",thinking:"Returned fixture thinking.",status:"complete",createdAt:"2026-10-03T08:00:02Z",parentToolCallId:"preview-delegation",agentName:"explorer"});
f.record.messages.push({id:"preview-final",role:"assistant",content:"文件已更新。可以展开工具行查看参数、结果，或打开审阅查看完整 diff。",status:"complete",createdAt:"2026-10-03T08:00:03Z",providerId:"preview",modelId:"sample",usage:{inputTokens:20000,outputTokens:1000,totalTokens:21000}});
const uploads = createMobileUploadStore(dataDir);
const operations = createOperations({getHost:() => f.host,isSessionBusy:id => !!f.bridge.agentHost.observeWorkTarget(id).activeTurnId,compact:async () => ({accepted:true}),resolveAttachments:uploads.resolve});
const provider={id:"preview",name:"Preview",type:"custom",enabled:true,hasSecret:true,supportsReasoning:true,supportedThinkingLevels:["off","high"],models:[{id:"sample",alias:"示例模型",contextWindow:200000,maxTokens:10000,thinkingLevels:["off","high"],defaultThinkingLevel:"high"}]};
const settings={defaultProviderId:"preview",defaultModelId:"sample",defaultMode:"agent",defaultPermissionMode:"ask",enterToSend:true,smoothStreaming:true,thinkingDisplayMode:"detailed",contextUsageDisplay:"remaining",theme:"light",language:"zh-CN",largePasteThreshold:1000};
const requests=new Map();const ingest=f.ingest.bind(f);f.ingest=(turnId,event)=>{if(event.type==="tool_permission_request")requests.set(event.request.requestId,event.request);ingest(turnId,event);};
const hostCall=f.host.call.bind(f.host);f.host.call=async(method,params={})=>{if(method==="session.getScratchPath")return {path:join(dataDir,"scratch",params.sessionId)};return hostCall(method,params);};
const nativeInvoke=async(channel,args)=>{
 const input=args[0]||{};
 if(channel===IPC.invoke.providersList)return {providers:[provider]};
 if(channel===IPC.invoke.providersListModels)return {models:[{providerId:"preview",modelId:"sample",displayName:"示例模型",contextWindow:200000,reasoning:true,supportedThinkingLevels:["off","high"]}]};
 if(channel===IPC.invoke.settingsGet)return settings;
 if(channel===IPC.invoke.sessionList)return {sessions:[...f.records.values()].map(row=>({...row,messageCount:row.messages.length}))};
 if(channel===IPC.invoke.sessionGet){const session=f.records.get(input.id);return {session:session?{...session,messageCount:session.messages.length,messageStart:0,hasMoreBefore:false,hasMoreAfter:false}:null};}
 if(channel===IPC.invoke.sessionCreate)return f.host.call("session.create",input);
 if(channel===IPC.invoke.sessionConfigure){await f.host.call("session.configure",{id:args[0],...args[1]});return {session:f.records.get(args[0])};}
 if(channel===IPC.invoke.sessionSummarizeTitle)return {title:"Preview task"};
 if(channel===IPC.invoke.agentGetStatus)return {status:{isRunning:!!f.bridge.agentHost.observeWorkTarget(args[0]).activeTurnId}};
 if(channel===IPC.invoke.sessionCollaboration)return {sessionId:input.sessionId,messages:[]};
 if(channel===IPC.invoke.todosGet)return {sessionId:input.sessionId,todos:[{id:"todo-1",content:"验证输入框",status:"completed",priority:"high"},{id:"todo-2",content:"验证权限请求",status:"in_progress",priority:"high"}],revision:1,updatedAt:Date.now()};
 if(channel===IPC.invoke.plansPending)return {plans:[]};
 if(channel===IPC.invoke.pendingInteractive)return {asks:f.bridge.agentHost.pendingInputRequests(input.sessionId).map(entry=>entry.original),permissions:f.bridge.agentHost.pendingApprovals(input.sessionId).filter(row=>row.kind==="tool").map(row=>requests.get(row.id)).filter(Boolean)};
 if(channel===IPC.invoke.promptEnhance)return {enhancedDraft:"[Fixture enhancement] "+input.draft};
 throw new Error("Unsupported preview IPC: "+channel);
};
const nativeUiOperations=createMobileNativeUiOperations({getHost:()=>f.host,invoke:nativeInvoke,agentHost:f.bridge.agentHost,dataDir,uploadStore:uploads,getComposerCommands:async()=>[{name:"compact",kind:"builtin",id:"builtin.agent.compact",title:"压缩上下文"}]});
const server = await startMobileCompanion({ agentHost: f.bridge.agentHost, confirmPairing:async () => ({approved:true,taskControl:{maxPermissionMode:"auto",allowSessionGrants:true}}), nativeUiOperations, browserAssets:await loadBrowserAssets(join(here,"../../out/mobile")), ...(process.env.PI_MOBILE_PREVIEW_PORT ? {port:Number(process.env.PI_MOBILE_PREVIEW_PORT)} : {}), listSessions: operations.sessions.list, operations, uploadStore: uploads, sessionData:createMobileSessionData(() => f.host,dataDir), diffAccess:createMobileDiffAccess(() => f.host), getModels:async () => [{providerId:"preview",id:"sample",name:"示例模型",contextWindow:200000,thinkingLevels:["off","high"]}], enhancePrompt:async request => ({enhancedDraft:"[Fixture enhancement] "+request.draft}), log: () => {} });
const statePath = join(here, "../../../..", ".pi-desktop-test/mobile-preview/connection.json");
await mkdir(dirname(statePath), { recursive: true });
await writeFile(statePath, JSON.stringify({ origin: server.origin, pairingCode: server.pairing.token, expiresAt:server.pairing.expiresAt }), { mode: 0o600 });
console.log(`Isolated mobile preview: ${server.origin}`);
console.log(`Private setup file: ${statePath}`);
console.log("Type demo for output, stream for paced deltas, request for approval/input cards, or close to stop.");
const commands = createInterface({ input: process.stdin });
let closing = false;
async function close() { if (closing) return; closing = true; commands.close(); process.stdin.pause(); await server.close(); await uploads.close(); await unlink(statePath).catch(() => {}); await rm(dataDir,{recursive:true,force:true}); }
let pending = Promise.resolve();
commands.on("line", line => {
  pending = pending.then(async () => {
    if (line.trim() === "close") { await close(); return; }
    if (closing) return;
    if (line.trim() === "pair") {
      const pairing=server.issuePairing();
      await writeFile(statePath,JSON.stringify({origin:server.origin,pairingCode:pairing.token,expiresAt:pairing.expiresAt}),{mode:0o600});
      console.log("Fresh isolated pairing available.");return;
    }
    if (line.trim() === "request") {
      const turnId = f.bridge.agentHost.observeWorkTarget(f.record.id).activeTurnId || await f.desktopTurn();
      f.ingest(turnId,{type:"agent_start"});
      f.ingest(turnId,{type:"tool_permission_request",request:{requestId:"preview-approval-"+Date.now(),sessionId:f.record.id,toolCallId:"preview-tool",toolName:"Write",argsPreview:{path:"example.txt",content:"Preview"},risk:"medium",reason:"Sample approval"}});
      f.ingest(turnId,{type:"asktool_request",request:{requestId:"preview-input-"+Date.now(),sessionId:f.record.id,toolCallId:"preview-input-tool",questions:[{question:"Which sample direction?",options:[{label:"Simple",description:"Minimal"},{label:"Detailed",description:"More detail"}]}]}});
      console.log("Sample interactive cards emitted."); return;
    }
    const streaming = line.trim() === "stream";
    if (line.trim() !== "demo" && !streaming) return;
    const turnId = f.bridge.agentHost.observeWorkTarget(f.record.id).activeTurnId || await f.desktopTurn();
    f.ingest(turnId, { type: "agent_start" });
    const message = { id: `preview-live-${f.promptCalls.length}`, role: "assistant", content: "", createdAt: new Date().toISOString(), status: "streaming" };
    f.ingest(turnId, { type: "message_start", message });
    const chunks = streaming ? Array.from({length:120},(_,i)=>`Delta ${i+1}. `) : ["Live desktop output. ", "The phone is following the same session."];
    for (const text of chunks) {
      message.content += text;
      f.ingest(turnId, { type: "message_update", message: { ...message }, deltaText: text });
      if(streaming) await new Promise(resolve=>setTimeout(resolve,40));
    }
    message.status = "complete";
    message.thinking = "Returned thinking from the isolated fixture.";
    f.record.messages.push(message);
    f.ingest(turnId, { type: "message_end", message });
    f.bridge.endTurn(f.record.id, turnId, "completed");
    console.log("Desktop fixture turn completed.");
  }).catch(() => console.error("Preview fixture action failed."));
});
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
