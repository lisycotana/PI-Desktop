import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs",import.meta.url));
const {createMobileNativeUiOperations}=await import("../electron/main/mobile/native-ui-operations.ts");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),"pi-mobile-native-ui-"));t.after(() => rm(directory,{recursive:true,force:true}));
  const root = join(directory,"project");const dataDir = join(directory,"data");const id = "123e4567-e89b-12d3-a456-426614174000";
  const scratch = join(dataDir,"scratch",id);const attachments = join(dataDir,"attachments");await Promise.all([mkdir(root,{recursive:true}),mkdir(scratch,{recursive:true}),mkdir(attachments,{recursive:true})]);
  execFileSync("git",["init","-q"],{cwd:root,windowsHide:true});
  await writeFile(join(root,"safe.txt"),"project content");await writeFile(join(scratch,"draft.txt"),"scratch content");
  const ownedBlob = "a".repeat(64);const otherBlob = "b".repeat(64);await writeFile(join(attachments,ownedBlob),"owned attachment");await writeFile(join(attachments,otherBlob),"other attachment");
  const record = {id,title:"Task",mode:"agent",permissionMode:"ask",thinkingLevel:"omit",projectPath:root,messageCount:3,createdAt:"2026-10-04T12:00:00Z",updatedAt:"2026-10-04T12:00:00Z",messages:[
    {id:"u1",role:"user",content:"Original",createdAt:"2026-10-04T12:00:00Z",attachments:[{kind:"file",name:"owned.txt",ref:"attachments/" + ownedBlob,mimeType:"text/plain"}]},
    {id:"a1",role:"assistant",content:"Answer",createdAt:"2026-10-04T12:00:01Z"},
    {id:"t1",role:"tool",toolName:"Write",toolStatus:"success",content:"",createdAt:"2026-10-04T12:00:02Z",toolResult:{details:{root:"workspace",review:{version:1,snapshotId:"snapshot-1",messageId:"t1",path:"safe.txt",operation:"write",status:"modified",state:"active",additions:1,deletions:1,hunks:[],reversible:true}}}},
  ]};
  const proposal = {id:"p1",sessionId:id,turnId:"turn-1",toolCallId:"call-1",version:3,status:"pending",kind:"goal",markdown:"Goal",plan:"Goal",title:"Goal",question:"Proceed?",createdAt:record.createdAt,updatedAt:record.updatedAt};
  const calls = [];const hostCalls=[];let busy = false;let scratchPath = scratch;
  const host = {async call(method,params) {hostCalls.push({method,params});if (method === "session.get") return {session:params.id === id ? structuredClone(record) : null};if (method === "projects.list") return {projects:[{path:root}]};if (method === "session.getScratchPath") return {path:scratchPath};throw new Error("Unexpected Host call: " + method);}};
  const invoke = async (channel,args) => {
    calls.push({channel,args});
    if (channel === IPC.invoke.providersList) return {providers:[{id:"provider",name:"Model account",vendorKey:"openai",type:"custom",protocol:"openai",enabled:true,hasSecret:true,authKind:"api-key",supportsReasoning:true,supportedThinkingLevels:["off","high"],models:[{id:"model",contextWindow:200000,maxTokens:10000,thinkingLevels:["off","high"],defaultThinkingLevel:"high",apiKey:"binding-secret"}],apiKey:"provider-secret",headers:{Authorization:"header-secret"},baseUrl:"https://private.invalid/?secret"}]};
    if (channel === IPC.invoke.providersListModels) return {models:[{providerId:"provider",modelId:"model",displayName:"Model",contextWindow:200000,capabilities:["text","tools"],reasoning:true,supportedThinkingLevels:["off","high"],source:"user",provider:{apiKey:"model-secret"},apiKey:"unlisted-secret"}]};
    if (channel === IPC.invoke.settingsGet) return {defaultProviderId:"provider",defaultModelId:"model",defaultMode:"agent",defaultPermissionMode:"ask",enterToSend:false,largePasteThreshold:1000,smoothStreaming:true,thinkingDisplayMode:"detailed",theme:"dark",keybindings:{abort:"Escape",apiKey:"keybinding-secret"},networkProxy:{url:"http://username:password@proxy.invalid"},voice:{token:"voice-secret"},promptEnhancementUserTemplate:"private template"};
    if (channel === IPC.invoke.sessionGet) return {session:{...structuredClone(record),messageStart:4,messageEnd:7,hasMoreBefore:true,hasMoreAfter:false}};
    if (channel === IPC.invoke.todosGet) return {sessionId:id,items:[],updatedAt:record.updatedAt};
    if (channel === IPC.invoke.sessionCollaboration) return {sessionId:id,messages:[]};
    if (channel === IPC.invoke.plansPending) return {plans:[structuredClone(proposal)]};
    if (channel === IPC.invoke.plansResolve) return {ok:true,proposal:{...proposal,status:"approved"},state:"inactive"};
    if (channel === IPC.invoke.sessionListRevisions) return {revisions:[{revisionIndex:1,isActive:true,messageCount:3,createdAt:record.createdAt}]};
    if (channel === IPC.invoke.sessionSaveRevision) return {revision:{revisionIndex:2,isActive:false,messageCount:args[0].messages.length,createdAt:record.createdAt}};
    if (channel === IPC.invoke.sessionActivateRevision) return {messages:record.messages};
    if (channel === IPC.invoke.workspaceReviewRollback) return {status:"rolledBack",snapshotId:args[0].snapshotId,messageId:"t1",path:"safe.txt"};
    if ([IPC.invoke.sessionReplaceMessages,IPC.invoke.sessionConfigure,IPC.invoke.agentCompact].includes(channel)) return {ok:true};
    throw new Error("Unexpected IPC: " + channel);
  };
  const operations = createMobileNativeUiOperations({getHost:() => host,invoke,isSessionBusy:() => busy,dataDir,getComposerCommands:async project => {assert.equal(project,root);return [{name:"agent-mode",title:"Agent",kind:"builtin",id:"builtin.mode.agent"},{name:"draft",title:"draft",kind:"template"},{name:"skill",title:"Skill",kind:"skill",skillId:"skill"},{name:"quit",title:"Quit",kind:"extension",id:"extension.quit"},{name:"settings",title:"Settings",kind:"plugin",id:"plugin.settings"}];}});
  return {operations,record,proposal,calls,hostCalls,root,dataDir,id,scratch,ownedBlob,otherBlob,setBusy:value => {busy=value;},setScratch:value => {scratchPath=value;}};
}

test("native UI bootstrap returns original public model shapes and composer settings without secrets",async t => {
  const f = await fixture(t);const value = await f.operations.dispatch("ui/bootstrap",{});
  assert.equal(value.providers[0].hasSecret,true);assert.equal(value.providers[0].models[0].contextWindow,200000);assert.equal(value.providerModels.provider[0].modelId,"model");assert.equal(value.settings.enterToSend,false);assert.deepEqual(value.settings.keybindings,{abort:"Escape"});
  const json = JSON.stringify(value);for (const secret of ["provider-secret","binding-secret","model-secret","header-secret","password","voice-secret","private template","private.invalid","keybinding-secret","unlisted-secret"]) assert.ok(!json.includes(secret),secret);
  assert.equal(f.calls.filter(call => call.channel === IPC.invoke.providersListModels)[0].args[0].source,"cache");
  await assert.rejects(() => f.operations.dispatch("ui/bootstrap",{channel:IPC.invoke.appQuit}),error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(() => f.operations.dispatch("app/quit",{}),error => error.code === "FORBIDDEN");
});

test("native UI session windows and pending cards keep original API fields",async t => {
  const f = await fixture(t);const value = await f.operations.dispatch("ui/session/get",{sessionId:f.id,messageBefore:7,messageLimit:3,contentLimit:100});
  assert.equal(value.session.messageStart,4);assert.equal(value.session.messageEnd,7);assert.equal(value.session.hasMoreBefore,true);
  assert.deepEqual(f.calls.at(-1).args,[{id:f.id,messageBefore:7,messageLimit:3,contentLimit:100}]);
  await f.operations.dispatch("ui/todos/get",{sessionId:f.id});assert.equal(f.calls.at(-1).channel,IPC.invoke.todosGet);
  await f.operations.dispatch("ui/plans/pending",{sessionId:f.id});assert.deepEqual(f.calls.at(-1).args,[{sessionId:f.id}]);
  await assert.rejects(() => f.operations.dispatch("ui/session/get",{sessionId:f.id,messageAfter:1}),error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(() => f.operations.dispatch("ui/todos/get",{sessionId:"missing"}),error => error.code === "NOT_FOUND");
});

test("plan resolution uses exact proposal identity and server authority despite a waiting turn",async t => {
  const f = await fixture(t);f.setBusy(true);const request={proposalId:"p1",sessionId:f.id,turnId:"turn-1",toolCallId:"call-1",version:3,action:"approve",targetPermissionMode:"auto"};
  await assert.rejects(() => f.operations.dispatch("ui/plans/resolve",request),error => error.code === "FORBIDDEN");
  await f.operations.dispatch("ui/plans/resolve",request,{maxPermissionMode:"auto"});assert.equal(f.calls.at(-1).channel,IPC.invoke.plansResolve);assert.deepEqual(f.calls.at(-1).args,[request]);
  await assert.rejects(() => f.operations.dispatch("ui/plans/resolve",{...request,version:2},{maxPermissionMode:"auto"}),error => error.code === "APPROVAL_STALE");
  await assert.rejects(() => f.operations.dispatch("ui/plans/resolve",{...request,toolCallId:"other"},{maxPermissionMode:"auto"}),error => error.code === "APPROVAL_STALE");
  await assert.rejects(() => f.operations.dispatch("ui/plans/resolve",{...request,authority:{maxPermissionMode:"auto"}}),error => error.code === "INVALID_ARGUMENT");
  await f.operations.dispatch("ui/plans/resolve",{proposalId:"p1",sessionId:f.id,turnId:"turn-1",toolCallId:"call-1",action:"reject"});assert.equal(f.calls.at(-1).args[0].version,3);
});

test("composer command catalogue and execution never expose arbitrary local commands",async t => {
  const f = await fixture(t);const value = await f.operations.dispatch("ui/composer/commands",{sessionId:f.id});assert.deepEqual(value.commands.map(command => command.kind),["builtin","template","skill"]);
  await f.operations.dispatch("ui/composer/execute",{sessionId:f.id,commandId:"builtin.mode.goal"});assert.deepEqual(f.calls.at(-1),{channel:IPC.invoke.sessionConfigure,args:[f.id,{mode:"goal"}]});
  await assert.rejects(() => f.operations.dispatch("ui/composer/execute",{sessionId:f.id,commandId:"plugin.settings"}),error => error.code === "FORBIDDEN");
  await assert.rejects(() => f.operations.dispatch("ui/composer/execute",{sessionId:f.id,commandId:"builtin.session.new"}),error => error.code === "FORBIDDEN");
  f.setBusy(true);await assert.rejects(() => f.operations.dispatch("ui/composer/execute",{sessionId:f.id,commandId:"builtin.agent.compact"}),error => error.code === "CONFLICT");
});

test("file access is session scoped and accepts complete paths within its canonical roots",async t => {
  const f = await fixture(t);const index = await f.operations.dispatch("ui/fs/index",{sessionId:f.id});assert.ok(index.entries.some(entry => entry.path === "safe.txt"),JSON.stringify(index));
  assert.equal((await f.operations.dispatch("ui/fs/read",{sessionId:f.id,ref:"safe.txt"})).content,"project content");
  assert.equal((await f.operations.dispatch("ui/fs/read",{sessionId:f.id,ref:"draft.txt"})).content,"scratch content");
  assert.equal((await f.operations.dispatch("ui/fs/read",{sessionId:f.id,ref:"attachments/" + f.ownedBlob,mimeType:"text/plain"})).content,"owned attachment");
  for (const ref of ["../project/safe.txt","attachments/" + f.otherBlob,"file:///etc/passwd","C:\\Windows\\win.ini"]) await assert.rejects(() => f.operations.dispatch("ui/fs/read",{sessionId:f.id,ref}),error => error.code === "REMOTE_PATH_FORBIDDEN");
  assert.equal((await f.operations.dispatch("ui/fs/read",{sessionId:f.id,ref:join(f.root,"safe.txt")})).content,"project content");
  f.record.projectPath = join(f.dataDir,"other-project");await assert.rejects(() => f.operations.dispatch("ui/fs/index",{sessionId:f.id}),error => error.code === "REMOTE_PATH_FORBIDDEN");
});

test("temporary tasks use only their Host owned scratch identity",async t => {
  const f = await fixture(t);delete f.record.projectPath;
  assert.equal((await f.operations.dispatch("ui/fs/read",{sessionId:f.id,ref:"draft.txt"})).content,"scratch content");
  await f.operations.dispatch("ui/messages/replace",{sessionId:f.id,messages:[]});assert.equal(f.calls.at(-1).channel,IPC.invoke.sessionReplaceMessages);
  f.setScratch(join(f.dataDir,"scratch","another-session"));await assert.rejects(() => f.operations.dispatch("ui/messages/replace",{sessionId:f.id,messages:[]}),error => error.code === "REMOTE_PATH_FORBIDDEN");
});

test("message edits permit user text and deletion while rejecting forged model rows and file references",async t => {
  const f = await fixture(t);const user={...f.record.messages[0],content:"Edited"};
  await f.operations.dispatch("ui/messages/replace",{sessionId:f.id,messages:[user]});assert.equal(f.calls.at(-1).args[0].messages[0].content,"Edited");
  await f.operations.dispatch("ui/messages/replace",{sessionId:f.id,messages:[{...user,attachments:[]}]});assert.deepEqual(f.calls.at(-1).args[0].messages[0].attachments,[]);
  await f.operations.dispatch("ui/messages/replace",{sessionId:f.id,messages:[f.record.messages[0],f.record.messages[2]]});assert.equal(f.calls.at(-1).args[0].messages.length,2);
  for (const messages of [[{...f.record.messages[1],content:"Forged assistant"}],[{...f.record.messages[2],toolResult:{secret:"forged"}}],[{...user,attachments:[{kind:"file",name:"secret",ref:"C:/outside/secret.txt"}]}],[{...user,id:"foreign-user"}],[f.record.messages[1],f.record.messages[0]],[{...user,authority:"owner"}]]) await assert.rejects(() => f.operations.dispatch("ui/messages/replace",{sessionId:f.id,messages}),error => error.code === "FORBIDDEN");
  f.setBusy(true);await assert.rejects(() => f.operations.dispatch("ui/messages/replace",{sessionId:f.id,messages:[]}),error => error.code === "CONFLICT");
});

test("revision and rollback actions bind authoritative transcript roots and session snapshots",async t => {
  const f = await fixture(t);
  await f.operations.dispatch("ui/revision/save",{sessionId:f.id,rootUserId:"u1",messages:f.record.messages,makeActive:false});assert.equal(f.calls.at(-1).channel,IPC.invoke.sessionSaveRevision);
  await f.operations.dispatch("ui/revision/list",{sessionId:f.id,rootUserId:"u1"});assert.equal(f.calls.at(-1).channel,IPC.invoke.sessionListRevisions);
  await f.operations.dispatch("ui/revision/activate",{sessionId:f.id,rootUserId:"u1",revisionIndex:1,prefix:[]});assert.equal(f.calls.at(-1).channel,IPC.invoke.sessionActivateRevision);
  await assert.rejects(() => f.operations.dispatch("ui/revision/activate",{sessionId:f.id,rootUserId:"u1",revisionIndex:1,prefix:[f.record.messages[1]]}),error => error.code === "FORBIDDEN");
  await assert.rejects(() => f.operations.dispatch("ui/revision/save",{sessionId:f.id,rootUserId:"u1",messages:[f.record.messages[1]]}),error => error.code === "FORBIDDEN");
  const result = await f.operations.dispatch("ui/workspace/rollback",{sessionId:f.id,snapshotId:"snapshot-1"});assert.equal(result.status,"rolledBack");
  await assert.rejects(() => f.operations.dispatch("ui/workspace/rollback",{sessionId:f.id,snapshotId:"another-session-snapshot"}),error => error.code === "FORBIDDEN");
});

test("original session permission configuration requires matching personal browser authority",async t => {
  const f=await fixture(t);const principal={subject:"browser-one",roles:["viewer","controller","approver"],pairedDevice:false};
  const authority={kind:"personal-browser",principalSubject:principal.subject,maxPermissionMode:"auto",allowSessionGrants:true};
  const context={maxPermissionMode:"auto",principal,authority};
  await f.operations.dispatch("ui/session/configure",{sessionId:f.id,mode:"agent",permissionMode:"auto"},context);
  assert.deepEqual(f.calls.at(-1).args,[f.id,{mode:"agent",permissionMode:"auto"}]);
  await assert.rejects(()=>f.operations.dispatch("ui/session/configure",{sessionId:f.id,permissionMode:"auto"}),error=>error.code==="FORBIDDEN");
  await assert.rejects(()=>f.operations.dispatch("ui/session/configure",{sessionId:f.id,permissionMode:"auto"},{...context,authority:{...authority,principalSubject:"different-browser"}}),error=>error.code==="FORBIDDEN");
  await assert.rejects(()=>f.operations.dispatch("ui/session/configure",{sessionId:f.id,permissionMode:"inherit"},context),error=>error.code==="FORBIDDEN");
  await assert.rejects(()=>f.operations.dispatch("ui/session/configure",{sessionId:f.id,apiKey:"secret"},context),error=>error.code==="INVALID_ARGUMENT");
});

test("new composer reads global commands and an empty index without inventing a session",async t => {
  const f=await fixture(t);
  assert.deepEqual(await f.operations.dispatch("ui/fs/index",{sessionId:""}),{entries:[],truncated:false});
  assert.ok((await f.operations.dispatch("ui/fs/index",{sessionId:"",projectPath:f.root})).entries.some(entry=>entry.path==="safe.txt"));
  await assert.rejects(()=>f.operations.dispatch("ui/fs/index",{sessionId:"",projectPath:f.dataDir}),error=>error.code==="REMOTE_PATH_FORBIDDEN");
  const value=await f.operations.dispatch("ui/project/read",{path:f.root});assert.equal(value.workspace.path,f.root);
  await assert.rejects(()=>f.operations.dispatch("ui/project/read",{path:f.dataDir}),error=>error.code==="REMOTE_PATH_FORBIDDEN");
});
