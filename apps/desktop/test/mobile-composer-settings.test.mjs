import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createContext, Script } from "node:vm";
register(new URL("./helpers/ts-import-hooks.mjs",import.meta.url));
const {mobileComposerSettingsScript}=await import("../electron/main/mobile/client-composer-settings.ts");
const {mobileControlsScript}=await import("../electron/main/mobile/client-controls.ts");

class Element {
  constructor() {this.value="";this.textContent="";this.children=[];this.attrs={};this.dataset={};this.listeners=new Map();this.disabled=false;this.hidden=false;this.open=false;this.scrollHeight=40;this.style={};}
  setAttribute(key,value) {this.attrs[key]=String(value);}
  append(...values) {this.children.push(...values);}
  replaceChildren(...values) {this.children=values;}
  addEventListener(type,fn) {this.listeners.set(type,fn);}
  focus() {this.focused=true;}
  setSelectionRange(start,end) {this.selection=[start,end];}
  async emit(type) {await this.listeners.get(type)?.();}
}
function harness() {
 const elements=new Map();const el=id => {if (!elements.has(id)) elements.set(id,new Element());return elements.get(id);};
 const session={id:"s1",mode:"agent",permissionMode:"auto",providerId:"p",modelId:"m"};
 const draft={text:"Original draft",attachments:[{id:"file-1",name:"file"}],model:"p:m",thinking:"high",pending:null};
 const state={generation:1,current:session,snapshot:null,sending:false,capabilities:{controls:true,promptEnhancement:true,remoteMaxPermissionMode:"accept-edits"},models:[{providerId:"p",id:"m",contextWindow:200000}],drafts:new Map([["s1",draft]]),configs:new Map()};
 const t=new Proxy({}, {get:(_target,key) => String(key)});const calls=[];let uuid=0;let enhancement=Promise.resolve({enhancedDraft:"Enhanced draft"});let failStart=false;let conversation=[];
 const api=async (path,init) => {const body=JSON.parse(init.body);calls.push({path,init,body});if (body.method === "prompt/enhance") return enhancement;if (body.method === "session/configure") return {session:{...state.current,...body.params}};if (body.method === "turn/start" && failStart) {failStart=false;throw new Error("Disconnected");}return {turn:{status:"running"}};};
 const ctx=createContext({state,el,t,api,messages:() => conversation,node:(_tag,text) => {const element=new Element();element.textContent=text || "";return element;},button:() => new Element(),crypto:{randomUUID:() => "uuid-" + ++uuid},snapshot:async () => {},acceptTurn:() => {},console});
 new Script(mobileComposerSettingsScript + "\n" + mobileControlsScript + "\nrenderModelMenu=()=>{};renderThinkingMenu=()=>{};renderAttachments=()=>{};initComposerSettings();").runInContext(ctx);
 el("message").value=draft.text;el("model").value="p:m";el("thinking").value="high";
 const run=code => new Script(code).runInContext(ctx);run("restoreComposerSettings();updateComposer();");
 const flush=async () => {for (let i=0;i<6;i++) await new Promise(setImmediate);};
 return {state,draft,el,calls,run,flush,setEnhancement:value => {enhancement=value;},failStart:() => {failStart=true;},setMessages:value => {conversation=value;}};
}

test("mobile composer changes PI task mode and narrows only the next turn permission", async () => {
 const h=harness();assert.deepEqual(h.el("composer-permission").children.map(x => x.value),["ask","accept-edits"]);
 h.el("composer-mode").value="goal";await h.el("composer-mode").emit("change");await h.flush();
 const configured=h.calls.find(call => call.body.method === "session/configure");assert.equal(configured.body.params.mode,"goal");assert.equal(configured.body.params.permissionMode,undefined);
 h.el("composer-permission").value="accept-edits";await h.el("composer-permission").emit("change");
 await h.run("sendMessage()");const turn=h.calls.find(call => call.body.method === "turn/start");assert.equal(turn.body.params.permissionModeCeiling,"accept-edits");assert.equal(turn.body.params.input.text,"Original draft");
 assert.equal(h.state.current.permissionMode,"auto");assert.equal(h.draft.text,"");
});

test("permission ceiling changes retry identity and unavailable permissions are removed", async () => {
 const h=harness();h.failStart();await h.run("sendMessage()");const first=h.calls.find(call => call.body.method === "turn/start");assert.equal(h.draft.text,"Original draft");
 h.el("composer-permission").value="accept-edits";h.run("saveDraft()");await h.run("sendMessage()");const second=h.calls.filter(call => call.body.method === "turn/start")[1];assert.notEqual(first.body.params.idempotencyKey,second.body.params.idempotencyKey);
 h.state.current.permissionMode="ask";h.run("updateComposerSettings()");assert.deepEqual(h.el("composer-permission").children.map(x => x.value),["ask"]);assert.equal(h.draft.permissionModeCeiling,"ask");
});

test("enhancement uses PI action and supports undo without changing attachments", async () => {
 const h=harness();await h.run("enhancePrompt()");assert.equal(h.el("message").value,"Enhanced draft");assert.equal(h.draft.enhancementUndo,"Original draft");assert.equal(h.draft.attachments[0].id,"file-1");
 const request=h.calls[0];assert.equal(request.body.method,"prompt/enhance");assert.equal(request.init.timeoutMs,65000);assert.deepEqual(request.body.params,{sessionId:"s1",draft:"Original draft",providerId:"p",modelId:"m",thinkingLevel:"high"});
 h.run("undoPromptEnhancement()");assert.equal(h.el("message").value,"Original draft");assert.equal(h.el("enhancement-undo").hidden,true);
});

test("late enhancement cannot overwrite an edited draft or another task", async () => {
 const h=harness();let release;h.setEnhancement(new Promise(resolve => {release=resolve;}));const pending=h.run("enhancePrompt()");h.el("message").value="User edited";h.run("saveDraft()");release({enhancedDraft:"Stale rewrite"});await pending;assert.equal(h.el("message").value,"User edited");
 let releaseNext;h.setEnhancement(new Promise(resolve => {releaseNext=resolve;}));const next=h.run("enhancePrompt()");h.state.generation++;h.state.current={...h.state.current,id:"s2"};releaseNext({enhancedDraft:"Wrong task"});await next;assert.equal(h.el("message").value,"User edited");
});

test("enhancement failure keeps the draft and manual editing clears undo", async () => {
 const h=harness();h.setEnhancement(Promise.reject(new Error("Provider unavailable")));await h.run("enhancePrompt()");assert.equal(h.el("message").value,"Original draft");assert.match(h.el("conversation-error").textContent,/Provider unavailable/);
 h.setEnhancement(Promise.resolve({enhancedDraft:"Better"}));await h.run("enhancePrompt()");h.el("message").value="Edited better";h.run("saveDraft();updateComposerSettings()");assert.equal(h.el("enhancement-undo").hidden,true);
});

test("editing away and back still invalidates an in-flight enhancement", async () => {
 const h=harness();let release;h.setEnhancement(new Promise(resolve => {release=resolve;}));const pending=h.run("enhancePrompt()");
 h.el("message").value="Temporary edit";h.run("saveDraft()");h.el("message").value="Original draft";h.run("saveDraft()");
 release({enhancedDraft:"Stale rewrite"});await pending;assert.equal(h.el("message").value,"Original draft");assert.equal(h.draft.enhancementUndo,undefined);
});

test("context remaining uses the latest model request including reasoning and cache", () => {
 const h=harness();assert.equal(h.el("context-remaining").textContent,"—");
 h.setMessages([{usage:{inputTokens:180000,outputTokens:10000}},{usage:{inputTokens:20000,outputTokens:10000,reasoningTokens:10000,cacheReadTokens:40000,cacheWriteTokens:20000}}]);h.run("updateComposerSettings()");assert.equal(h.el("context-remaining").textContent,"50%");assert.match(h.el("context-remaining").title,/100,000 \/ 200,000/);
 h.setMessages([{usage:{inputTokens:250000,outputTokens:1}}]);h.run("updateComposerSettings()");assert.equal(h.el("context-remaining").textContent,"0%");assert.equal(h.el("context-remaining").dataset.low,"true");
});
