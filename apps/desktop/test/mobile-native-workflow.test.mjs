import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs",import.meta.url));
const {mobileFixture}=await import("./helpers/mobile-fixture.mjs");
const {startMobileCompanion}=await import("../electron/main/mobile/readonly-server.ts");
const {createOperations}=await import("../electron/main/mobile/backend-operations.ts");
const {createMobileNativeUiOperations}=await import("../electron/main/mobile/native-ui-operations.ts");

test("fixed native HTTP operations preserve history edits, browser authority and large original transcripts",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"pi-native-workflow-"));
  const f=mobileFixture({projectPath:null});const edits=[];
  const hostCall=f.host.call.bind(f.host);
  f.host.call=(method,params)=>method==="session.getScratchPath"?Promise.resolve({path:join(directory,"scratch",params.sessionId)}):hostCall(method,params);
  f.record.permissionMode="auto";
  f.record.messages[1].content="Long returned model output. ".repeat(15000);
  const nativeUiOperations=createMobileNativeUiOperations({getHost:()=>f.host,agentHost:f.bridge.agentHost,dataDir:directory,invoke:async(channel,args)=>{
    assert.equal(channel,IPC.invoke.sessionReplaceMessages);edits.push(args[0]);return {ok:true};
  }});
  const server=await startMobileCompanion({agentHost:f.bridge.agentHost,listSessions:f.listSessions,nativeUiOperations,operations:createOperations({getHost:()=>f.host,isSessionBusy:()=>false,compact:async()=>({accepted:true})}),confirmPairing:async()=>({approved:true,taskControl:{maxPermissionMode:"auto",allowSessionGrants:true}}),log:()=>{}});
  t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
  let cookie="",csrf="";
  const post=(path,body)=>fetch(server.origin+path,{method:"POST",headers:{"Content-Type":"application/json","X-PI-Origin":server.origin,"X-PI-CSRF":csrf,Cookie:cookie},body:JSON.stringify(body)});
  const pending=await (await post("/v1/browser/pair",{token:server.pairing.token})).json();let completion;
  for(let attempt=0;attempt<5;attempt++) {
    completion=await post("/v1/browser/pair/complete",{requestId:pending.requestId,secret:pending.secret});
    const result=await completion.json();if(result.status==="approved"){assert.ok(!result.roles.includes("owner"));csrf=result.csrf;cookie=completion.headers.get("set-cookie").split(";")[0];break;}
  }
  assert.ok(csrf);
  const replaced=await post("/v1/native/ui/messages/replace",{sessionId:f.record.id,messages:f.record.messages});assert.equal(replaced.status,200,await replaced.text());
  assert.deepEqual(edits[0].messages,f.record.messages);
  assert.equal((await post("/v1/native/ui/turn/prompt",{sessionId:f.record.id,content:"Edit original prompt",messageId:randomUUID(),truncateFromMessageId:"message-0"})).status,200);
  assert.equal(f.promptCalls[0][0].truncateFromMessageId,"message-0");
  assert.equal(f.promptCalls[0][0].permissionMode,"auto");
  assert.equal((await post("/v1/native/ui/turn/prompt",{sessionId:f.record.id,content:"Cannot edit while running",truncateFromMessageId:"message-0"})).status,409);
  const queue=await (await post("/v1/native/ui/queue/push",{sessionId:f.record.id,content:"Follow up",messageId:randomUUID()})).json();
  assert.ok(queue.id);assert.equal(queue.content,"Follow up");
  assert.equal((await post("/v1/native/ui/turn/prompt",{sessionId:f.record.id,content:"Forged",channel:IPC.invoke.appQuit})).status,400);
});
