import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import { applyMessageUpdate } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { mobileAssets } = await import("../electron/main/mobile/web-assets.ts");
const { getToolSummary, getToolAction } = await import("../src/lib/tool-display.ts");

/** DOM boundary fake: the real served script and its internal wiring run unchanged. */
class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = new Map(); this._text = ""; this._value = ""; this.hidden = false; this.disabled = false; this.open = false; this.scrollTop = 0; this.scrollHeight = 500; this.clientHeight = 400; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(""); }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  insertBefore(n,reference) { if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);const index=reference?this.children.indexOf(reference):-1;n.parent=this;if(index<0)this.children.push(n);else this.children.splice(index,0,n);return n;}
  replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === "id") this.id = value; if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_,c) => c.toUpperCase())] = value; }
  getAttribute(name) { return this.attrs[name]; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type,list); }
  async emit(type) { if (this.disabled) return; const event = {preventDefault() {},target:this}; await Promise.all((this.listeners.get(type) || []).map(listener => listener(event))); }
  click() { if (this.tagName === "A") this.document.downloads.push({name:this.download,href:this.href}); return this.emit("click"); }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollIntoView() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  querySelectorAll(selector) {
    const match = n => selector === "details[open]" ? n.tagName === "DETAILS" && n.open : selector === "input:checked" ? n.tagName === "INPUT" && n.checked : selector.startsWith("[data-") ? n.attrs[selector.slice(1,-1)] !== undefined : n.tagName === selector.toUpperCase();
    return this.children.flatMap(n => [...(match(n) ? [n] : []),...n.querySelectorAll(selector)]);
  }
}

function documentFromHtml(html) {
  const document = { hidden:false,downloads:[],ids:new Map(),listeners:new Map(),activeElement:null };
  document.createElement = tag => new Element(tag,document);
  document.createTextNode = text => { const n = new Element("#text",document); n.textContent = text; return n; };
  document.body = document.createElement("body"); document.documentElement = document.createElement("html");
  document.getElementById = id => document.ids.get(id);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.addEventListener = (type,listener) => document.listeners.set(type,listener);
  const stack = [document.body];
  for (const token of html.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
    const tag = token[1].toLowerCase(); if (["html","head","body","meta","link","script","title"].includes(tag)) continue;
    if (token[0].startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
    const n = document.createElement(tag); for (const attr of token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) { n.setAttribute(attr[1],attr[2] ?? ""); if (["hidden","multiple","required"].includes(attr[1])) n[attr[1]] = true; if (attr[1] === "type") n.type = attr[2]; } if (n.id) document.ids.set(n.id,n); stack.at(-1).append(n); if (!["input","br","img"].includes(tag)) stack.push(n);
  }
  return document;
}

const message = (id,content,extra = {}) => ({id,role:"assistant",content,createdAt:"2026-10-03T08:00:00Z",...extra});
const item = m => ({id:m.id,itemType:m.role === "tool" ? "tool" : "message",createdAt:m.createdAt,content:m});
const session = {id:"task-1",title:"Review desktop changes",updatedAt:"2026-10-03T08:00:00Z",status:"idle",mode:"agent"};
const response = body => ({ok:true,status:200,json:async () => body,text:async () => body});

function harness({language = "en-US",controls = true,launchHash = ""} = {}) {
  const document = documentFromHtml(mobileAssets["/"].body); const calls = []; const timers = new Map(); let uuid = 0; let timerId = 0; let paired = false; let failStart = false; let startGate; let snapshotGate; let patchGate;let approvalGate;
  const snapshots = {session,activeTurn:undefined,items:[item(message("answer","Initial answer"))],activeItems:[],queuedTurns:[],pendingApprovals:[],pendingInputs:[],cursor:{epoch:"epoch",sequence:1},revision:1};
  const sessions = [session]; const downloads = [];
  const location = new URL("https://pi.example/" + launchHash);const replacements=[];
  const history = {replaceState(_state,_title,url) {replacements.push(url);location.href=new URL(url,location).href;}};
  const windowListeners=new Map();
  const fetch = async (path,init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {}; calls.push({path,init,body,hash:location.hash});
    if (path === "/v1/browser/session") return {ok:false,status:401};
    if (path === "/v1/browser/pair") return response({status:"pending",requestId:"request",secret:"completion",verificationCode:"123456",expiresAt:"2099-01-01T00:00:00Z"});
    if (path === "/v1/browser/pair/complete") { paired = true; return response({status:"approved",csrf:"test-csrf"}); }
    if (!paired) return {ok:false,status:401};
    if (path === "/v1/sessions") return response({sessions});
    if (path === "/v1/capabilities") return response({controls});
    if (path === "/v1/models") return response({models:[{providerId:"provider",id:"model",name:"Test model",thinkingLevels:["off","high"]}]});
    if (path.endsWith("/history")) return response({items:init.headers["X-PI-History-Before"] ? [item(message("earlier","Earlier answer"))] : [item(message("user","Original user message",{role:"user"}))],hasMore:!init.headers["X-PI-History-Before"]});
    if (path.endsWith(":attach")) return snapshotGate ? snapshotGate : response({session,snapshot:structuredClone(snapshots)});
    if (path.endsWith("/events")) return {ok:true,status:200,body:{getReader:() => ({read:() => new Promise(() => {}),cancel:async () => {}})}};
    if (path.endsWith("/attachments")) return response({id:"upload-1",name:body.name,kind:"file",mimeType:body.mimeType,size:3});
    if (path.endsWith("/diff/list")) return response({repo:true,clean:false,files:[{path:body.offset ? "src/second.ts" : "src/first.ts",status:"modified"}],nextOffset:body.offset ? undefined : 1,total:2});
    if (path.endsWith("/review/list")) return response({entries:[],hasMore:false});
    if (path.endsWith("/diff/patch")) return patchGate ? patchGate : response("diff --git a/" + body.path + " b/" + body.path + "\n+" + "full text ".repeat(25000));
    if (path === "/v1/action") {
      if (body.method === "project/list") return response({projects:[{id:"project",label:"Desktop project",archived:false}]});
      if (body.method === "turn/start") { if (failStart) { failStart = false; throw new Error("Network timeout"); } if (startGate) return startGate; snapshots.activeTurn = {id:"active-turn",status:"running"}; return response({turn:snapshots.activeTurn}); }
      if (body.method === "approval/respond") {if(approvalGate)return approvalGate;snapshots.pendingApprovals=snapshots.pendingApprovals.filter(r=>r.id!==body.params.approvalId);return response({approvalId:body.params.approvalId,status:"resolved"});}
      if (body.method === "input/respond") {snapshots.pendingInputs=snapshots.pendingInputs.filter(r=>r.id!==body.params.inputId);return response({inputId:body.params.inputId,status:"resolved"});}
      if (body.method === "session/create" || body.method === "session/fork") return response({session:{...session,id:"new-task",title:body.params.title || "New task"}});
      if (body.method === "workspace/diff") return response({repo:true,clean:false,truncated:true,files:[{path:"src/first.ts",status:"modified",tooLarge:true,hunks:[]}]});
      if (body.method === "workspace/list") return response({entries:[{name:"file.ts",kind:"file",size:4},{name:"folder",kind:"dir",size:0}]});
      if (body.method === "workspace/read") return response({kind:"text",content:"Complete file content",size:21});
      return response({ok:true});
    }
    throw new Error("Unexpected request: " + path);
  };
  class FakeURL extends URL { static createObjectURL(blob) { downloads.push(blob); return "blob:test"; } static revokeObjectURL() {} }
  const ctx = createContext({document,navigator:{language,clipboard:{writeText:async text => { ctx.copied = text; }}},location,history,window:{addEventListener(type,listener) {windowListeners.set(type,listener);},matchMedia:() => ({matches:false,addEventListener(){}})},fetch,crypto:{randomUUID:() => "uuid-" + ++uuid},AbortController,TextDecoder,Uint8Array,URL:FakeURL,URLSearchParams,Blob,requestAnimationFrame:run => {timers.set(++timerId,{run,time:16});return timerId;},cancelAnimationFrame:id=>timers.delete(id),btoa:text => Buffer.from(text,"binary").toString("base64"),setTimeout:(run,time) => {timers.set(++timerId,{run,time});return timerId;},clearTimeout:id => timers.delete(id),console});
  new Script(mobileAssets["/app.js"].body).runInContext(ctx);
  const run = code => new Script(code).runInContext(ctx);
  const get = id => document.getElementById(id);
  const flush = async () => { for (let n = 0; n < 12; n++) await new Promise(setImmediate); };
  const pair = async () => { await flush(); get("code").value = "pair-token"; await get("pair-form").emit("submit"); await flush(); };
  const open = async () => { await get("session-list").querySelectorAll("button").find(n => n.className === "session-row").click(); await flush(); };
  return {ctx,document,calls,snapshots,timers,downloads,run,get,flush,pair,open,replacements,windowListeners,failNextStart:() => {failStart = true;},gateStart:value => {startGate = value;},gateSnapshot:value => {snapshotGate = value;},gatePatch:value => {patchGate = value;},gateApproval:value=>{approvalGate=value;}};
}

test("QR navigation removes its fragment before the first request and does not race session restore",async()=>{
 const hash="#"+new URLSearchParams({pair:"qr-token",expires:"2099-01-01T00:00:00Z"});const h=harness({launchHash:hash});await h.flush();assert.deepEqual(h.replacements,["/"]);assert.equal(h.ctx.location.hash,"");assert.ok(h.calls.every(c=>c.hash===""));assert.equal(h.calls.filter(c=>c.path==="/v1/browser/pair").length,1);assert.equal(h.calls.some(c=>c.path==="/v1/browser/session"),false);assert.equal(h.document.documentElement.dataset.view,"sessions");
 const reload=harness({launchHash:h.ctx.location.hash});await reload.flush();assert.equal(reload.calls[0].path,"/v1/browser/session");assert.equal(reload.calls.some(c=>c.path==="/v1/browser/pair"),false);
 assert.ok(mobileAssets["/"].body.indexOf('src="/app.js"')<mobileAssets["/"].body.indexOf('src="/qr-decoder.js"'));
});

test("invalid link fragments are removed without sending an authentication request",async()=>{
 const h=harness({launchHash:"#pair=a&pair=b&expires=2099-01-01"});await h.flush();assert.equal(h.ctx.location.hash,"");assert.equal(h.calls.length,0);assert.ok(h.get("pair-error").textContent.length>0);
});

test("a new pairing link in the same tab is consumed exactly once",async()=>{
 const h=harness();await h.flush();h.ctx.location.hash=new URLSearchParams({pair:"second-qr",expires:"2099-01-01T00:00:00Z"}).toString();h.windowListeners.get("hashchange")();await h.flush();assert.equal(h.ctx.location.hash,"");assert.equal(h.calls.filter(c=>c.path==="/v1/browser/pair").length,1);h.windowListeners.get("hashchange")();await h.flush();assert.equal(h.calls.filter(c=>c.path==="/v1/browser/pair").length,1);
});

test("served transcript applies the shared delta reducer, keeps thinking and full tool JSON, and renders safe rich text", async () => {
  const h = harness(); await h.pair(); await h.open();
  const start = message("live","",{status:"streaming"}); h.ctx.event = {kind:"item.started",occurredAt:start.createdAt,payload:{event:{type:"message_start",message:start}}}; h.run("applyEvent(event)");
  const update = {type:"message_update",stream:"delta",message:start,deltaText:"Hello",deltaThinking:"Reasoning"}; h.ctx.event.payload.event = update; h.run("applyEvent(event)");
  const reset = {...update,deltaText:"Replacement",resetText:true,deltaThinking:"Reset reasoning",resetThinking:true}; h.ctx.event.payload.event = reset; h.run("applyEvent(event);renderTranscript()");
  const expected = applyMessageUpdate(applyMessageUpdate(start,update),reset); assert.equal(h.run("messages().find(m => m.id === 'live').content"),expected.content); assert.equal(h.run("messages().find(m => m.id === 'live').thinking"),expected.thinking);
  const toolText = "large result ".repeat(20000); h.ctx.toolText = toolText; h.run("applyEvent({occurredAt:'2026-10-03T08:00:01Z',payload:{event:{type:'tool_start',toolCallId:'tool-id',toolName:'read',args:{path:'src/file.ts'}}}});applyEvent({occurredAt:'2026-10-03T08:00:02Z',payload:{event:{type:'tool_end',toolCallId:'tool-id',result:{text:toolText},isError:true}}});renderTranscript()");
  const tool=h.get("transcript").children.find(n=>n.dataset.item==="tool-id");assert.equal(tool.textContent.includes(toolText),false);tool.open=true;await tool.emit("toggle");assert.ok(tool.textContent.includes(toolText));const thinking=h.get("transcript").querySelectorAll("details").find(n=>n.dataset.item==="live:thinking");thinking.open=true;await thinking.emit("toggle");assert.ok(thinking.textContent.includes("Reset reasoning")); assert.equal(h.run("messages().find(m => m.id === 'tool-id').toolDurationMs"),1000);
  h.ctx.rich = "# Heading\n\n- First\n- Second\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```js\n<script>unsafe()</script>\n```\n[Good](https://example.com) [Bad](javascript:alert(1))";
  const rich = h.run("markdown(rich)"); assert.equal(rich.querySelectorAll("table").length,1); assert.equal(rich.querySelectorAll("li").length,2); assert.equal(rich.querySelectorAll("a").length,1); assert.equal(rich.querySelectorAll("script").length,0); assert.ok(rich.textContent.includes("<script>unsafe()</script>"));
  assert.equal(h.run("isWorkspacePath('F:/secret')"),false); assert.equal(h.run("isWorkspacePath('../secret')"),false); assert.equal(h.run("isWorkspacePath('src/file.ts')"),true);
});

test("mobile user path pairs, selects model, uploads, retries an uncertain send once, and controls actual turn ids", async () => {
  const h = harness(); await h.pair(); assert.equal(h.get("pair").hidden,true); assert.equal(h.get("new-task").hidden,false); h.get("search").value = "no match"; await h.get("search").emit("input"); assert.equal(h.get("session-list").children[0].tagName,"P"); h.get("search").value = "Review"; await h.get("search").emit("input"); await h.open();
  h.get("model").value = "provider:model"; await h.get("model").emit("change"); h.get("thinking").value = "high"; await h.get("thinking").emit("change"); await h.flush();
  h.ctx.files = [{name:"note.txt",type:"text/plain",arrayBuffer:async () => Uint8Array.from([65,66,67]).buffer}]; await h.run("uploadFiles(files)"); assert.ok(h.get("attachment-list").textContent.includes("note.txt"));
  h.get("message").value = "Continue this task"; await h.get("message").emit("input"); h.failNextStart(); await h.get("composer").emit("submit"); await h.flush(); assert.equal(h.get("message").value,"Continue this task"); assert.ok(h.get("conversation-error").textContent.includes("retained"));
  await h.get("composer").emit("submit"); await h.flush(); const starts = h.calls.filter(c => c.body.method === "turn/start"); assert.equal(starts.length,2); assert.equal(starts[0].body.params.idempotencyKey,starts[1].body.params.idempotencyKey); assert.equal(starts[1].body.params.context.requestId,starts[0].body.params.context.requestId); assert.deepEqual(starts[1].body.params.input.attachments,["upload-1"]); assert.equal(h.get("message").value,""); assert.equal(h.get("attachment-list").children.length,0);
  const config = h.calls.filter(c => c.body.method === "session/configure").at(-1).body.params; assert.equal(config.modelId,"model"); assert.equal(config.thinkingLevel,"high"); const upload = h.calls.find(c => c.path.endsWith("/attachments")); assert.equal(upload.body.data,"QUJD"); assert.equal(upload.init.headers["X-PI-CSRF"],"test-csrf");
  await h.get("stop").click(); await h.flush(); assert.equal(h.calls.find(c => c.body.method === "turn/stop").body.params.turnId,"active-turn");
  h.snapshots.queuedTurns = [{id:"queued-turn",queuePosition:1}]; await h.run("snapshot(state.generation)"); await h.get("queue").querySelectorAll("button")[0].click(); await h.flush(); await h.get("queue").querySelectorAll("button")[1].click(); await h.flush(); assert.equal(h.calls.find(c => c.body.method === "turn/prioritize").body.params.turnId,"queued-turn"); assert.equal(h.calls.find(c => c.body.method === "turn/cancel").body.params.turnId,"queued-turn");
});

test("approval/input cards send advertised choices and Changes pages and downloads complete evidence", async () => {
  const h = harness(); await h.pair(); await h.open();
  h.snapshots.pendingApprovals = [{id:"approval",summary:"Read workspace",expiresAt:"2099-01-01",revision:4,allowedDecisions:["allow-once","deny"],kind:"tool"}]; h.snapshots.pendingInputs = [{id:"input",expiresAt:"2099-01-01",questions:[{id:"q1",question:"Choose a path",options:["First","Second"],multiSelect:true}]}]; await h.run("snapshot(state.generation)");
  await h.get("requests").children[0].querySelectorAll("button")[0].click(); await h.flush(); const approval = h.calls.find(c => c.body.method === "approval/respond").body.params; assert.equal(approval.decision,"allow-once"); assert.equal(approval.context.expectedRevision,4);
  const form = h.get("requests").children.find(n=>n.tagName==="FORM"); const inputs = form.querySelectorAll("input"); inputs[0].checked = true; await inputs[0].emit("change"); inputs[2].value = "Details"; await inputs[2].emit("input"); await form.emit("submit"); await h.flush(); assert.deepEqual(h.calls.find(c => c.body.method === "input/respond").body.params.answers,[["First","Details"]]);
  await h.get("changes-tab").click(); await h.flush(); assert.equal(h.get("changes-panel").hidden,false); assert.ok(h.get("diff-files").textContent.includes("100 files")); await h.get("diff-more").click(); await h.flush(); assert.ok(h.get("diff-files").textContent.includes("src/second.ts")); assert.equal(h.get("diff-more").hidden,true);
  await h.get("diff-files").children[1].querySelectorAll("button")[0].click(); await h.flush(); const expectedLength = (await response("full text ".repeat(25000)).text()).length; assert.ok(h.get("file-content").textContent.length > expectedLength); await h.get("file-content").querySelectorAll("button")[1].click(); assert.equal(h.document.downloads.at(-1).name,"first.ts.patch"); assert.ok((await h.downloads.at(-1).text()).length > 200000);
  h.get("workspace-path").value = "src"; await h.get("workspace-form").emit("submit"); await h.flush(); await h.get("workspace-files").querySelectorAll("button")[1].click(); await h.flush(); assert.ok(h.get("file-content").textContent.includes("Complete file content"));
});

test("session dialogs require explicit submission and stale sends do not clear another task draft", async () => {
  const h = harness({language:"zh-CN"}); await h.pair(); await h.open(); await h.get("delete").click(); assert.equal(h.get("task-dialog").open,true); assert.equal(h.calls.some(c => c.body.method === "session/delete"),false); assert.ok(h.get("dialog-content").textContent.includes("永久删除")); await h.get("dialog-content").querySelectorAll("button").at(-1).click();
  await h.get("rename").click(); const renameForm = h.get("dialog-content").querySelectorAll("form")[0]; renameForm.querySelectorAll("input")[0].value = "Renamed task"; await renameForm.emit("submit"); assert.equal(h.get("conversation-title").textContent,"Renamed task");
  let resolve; h.gateStart(new Promise(r => {resolve = r;})); h.get("message").value = "First task draft"; await h.get("message").emit("input"); await h.get("composer").emit("submit"); await h.flush(); await h.run("open({...state.current,id:'another-task'})"); h.get("message").value = "Another task draft"; await h.get("message").emit("input"); resolve(response({turn:{id:"late-turn",status:"running"}})); await h.flush(); assert.equal(h.get("message").value,"Another task draft"); assert.equal(h.run("state.drafts.get('task-1').text"),"First task draft");
});

test("snapshot races preserve newer stream deltas and the service worker never caches API requests", async () => {
  const h = harness(); await h.pair(); await h.open(); h.run("applyEvent({payload:{event:{type:'message_start',message:{id:'racing',role:'assistant',content:'Initial',createdAt:'2026-10-03'}}}})");
  let resolve; h.gateSnapshot(new Promise(r => {resolve = r;})); const pending = h.run("snapshot(state.generation)"); h.run("applyEvent({payload:{event:{type:'message_update',stream:'delta',message:{id:'racing',role:'assistant',content:'',createdAt:'2026-10-03'},deltaText:' newer',deltaThinking:'Retained thinking'}}})"); resolve(response({session,snapshot:{...h.snapshots,activeItems:[item(message("racing","Old snapshot"))]}})); await pending; assert.equal(h.run("messages().find(m => m.id === 'racing').content"),"Initial newer"); assert.equal(h.run("messages().find(m => m.id === 'racing').thinking"),"Retained thinking");
  const handlers = {}; const worker = createContext({self:{location:{origin:"https://pi.example"},addEventListener:(kind,handler) => {handlers[kind] = handler;}},URL,caches:{},fetch(){assert.fail("API must bypass the shell worker");}}); new Script(mobileAssets["/sw.js"].body).runInContext(worker); for (const path of ["/v1/sessions","/v1/models","/v1/sessions/task-1/events"]) handlers.fetch({request:{method:"GET",url:"https://pi.example" + path},respondWith(){assert.fail("API must not be cached");}});
});

test("Desktop tool summaries, model sheet, scroll ownership and numbered diff preserve complete evidence", async () => {
  const h = harness({language:"zh-CN"});await h.pair();await h.open();
  await h.get("model-toggle").click();assert.equal(h.get("model-dialog").open,true);
  h.get("model").value = "provider:model";await h.get("model").emit("change");h.get("thinking").value = "high";await h.get("thinking").emit("change");await h.flush();
  assert.equal(h.calls.filter(c => c.body.method === "session/configure").at(-1).body.params.thinkingLevel,"high");assert.ok(h.get("model-label").textContent.includes("高"));
  await h.get("model-close").click();const generation=h.run("state.generation");await h.get("back").click();await h.flush();assert.equal(h.document.documentElement.dataset.drawer,"open");assert.equal(h.run("state.generation"),generation);assert.equal(h.get("conversation").hidden,false);await h.get("drawer-close").click();assert.equal(h.document.documentElement.dataset.drawer,"closed");
  const command = "echo first\necho second " + "full ".repeat(150);h.ctx.args = {command};h.ctx.toolName = "Bash";
  assert.equal(h.run("getToolSummary(toolName,args)"),getToolSummary("Bash",{command}));assert.equal(h.run("getToolAction(toolName)"),getToolAction("Bash"));
  h.ctx.command = command;h.run("applyEvent({occurredAt:'2026-10-03T08:01:00Z',payload:{event:{type:'tool_start',toolCallId:'long-command',toolName:'Bash',args:{command}}}});renderTranscript()");const commandRow=h.get("transcript").children.find(n=>n.dataset.item==="long-command");commandRow.open=true;await commandRow.emit("toggle");assert.ok(commandRow.textContent.includes(command));
  const scroll = h.get("transcript-scroll");scroll.scrollHeight = 1200;scroll.scrollTop = 0;await scroll.emit("scroll");assert.equal(h.get("jump-latest").hidden,false);await h.get("jump-latest").click();assert.equal(scroll.scrollTop,1200);
  const patch = h.run("patchView('@@ -10,2 +10,2 @@\\n old\\n-removed\\n+added')");const lines = patch.children;assert.equal(lines[1].children[0].textContent,"10");assert.equal(lines[2].children[0].textContent,"11");assert.equal(lines[3].children[1].textContent,"11");assert.equal(lines[3].children[2].textContent,"+added");
});

test("model search and thinking choices configure advertised values while busy choices stay disabled",async()=>{
 const h=harness();await h.pair();await h.open();h.run("state.models.push({providerId:'other',id:'second',name:'Second model',thinkingLevels:['low','high']});renderModelMenu()");
 await h.get("model-toggle").click();h.get("model-search").value="Second";await h.get("model-search").emit("input");const choices=h.get("model-list").querySelectorAll("button");assert.equal(choices.length,1);assert.equal(choices[0].textContent,"Second model");await choices[0].click();await h.flush();assert.equal(h.calls.filter(c=>c.body.method === "session/configure").at(-1).body.params.modelId,"second");
 await h.get("thinking-levels").querySelectorAll("button").find(n=>n.textContent === "High").click();await h.flush();assert.equal(h.calls.filter(c=>c.body.method === "session/configure").at(-1).body.params.thinkingLevel,"high");
 h.snapshots.activeTurn={id:"busy-turn"};await h.run("snapshot(state.generation)");assert.ok(h.get("model-list").querySelectorAll("button").every(n=>n.disabled));assert.ok(h.get("thinking-levels").querySelectorAll("button").every(n=>n.disabled));
 const generation=h.run("state.generation");await h.get("refresh").click();assert.equal(h.run("state.generation"),generation);assert.equal(h.run("state.current.id"),"task-1");
});


test("new tasks return to the mobile home and preserve an unfinished draft",async()=>{
 const h=harness();await h.pair();await h.open();await h.get("new-task").click();const form=h.get("dialog-content").querySelectorAll("form")[0];await form.emit("submit");await h.flush();assert.equal(h.run("state.current.id"),"new-task");h.get("message").value="Keep this draft";await h.get("message").emit("input");await h.get("home").click();await h.flush();assert.equal(h.document.documentElement.dataset.view,"sessions");assert.equal(h.run("state.current"),null);assert.equal(h.run("state.drafts.get('new-task').text"),"Keep this draft");
});

test("snapshots retain a question's focused field and permission decisions resolve once",async()=>{
 const h=harness();await h.pair();await h.open();h.snapshots.pendingApprovals=[{id:"deny-me",summary:"Write",expiresAt:"2099-01-01",revision:4,allowedDecisions:["allow-once","deny"]}];h.snapshots.pendingInputs=[{id:"question",expiresAt:"2099-01-01",questions:[{id:"q",question:"Choose",options:["A","B"]}]}];await h.run("snapshot(state.generation)");const form=h.get("requests").children.find(n=>n.tagName==="FORM");const free=form.querySelectorAll("input").at(-1);free.value="Still typing";await free.emit("input");free.focus();await h.run("snapshot(state.generation)");assert.equal(h.document.activeElement,free);assert.equal(h.get("requests").children.find(n=>n.tagName==="FORM"),form);assert.equal(free.value,"Still typing");const deny=h.get("requests").children[0].querySelectorAll("button").find(n=>n.textContent==="Deny");await deny.click();await h.flush();assert.equal(h.calls.filter(c=>c.body.method==="approval/respond").length,1);assert.equal(h.calls.find(c=>c.body.method==="approval/respond").body.params.decision,"deny");await form.emit("submit");await h.flush();assert.deepEqual(h.calls.find(c=>c.body.method==="input/respond").body.params.answers,[["Still typing"]]);assert.equal(h.get("requests").children.length,0);
});

test("incremental output retains completed rows and defers full records until opened",async()=>{
 const h=harness();await h.pair();await h.open();const fixed=h.get("transcript").children[0];const m=message("burst","",{status:"streaming"});h.ctx.m=m;h.run("applyEvent({payload:{event:{type:'message_start',message:m}}});renderTranscript()");const live=h.get("transcript").children.find(n=>n.dataset.item==="burst");const detail=live.querySelectorAll("details").find(n=>n.dataset.item==="burst:raw");assert.equal(detail.children[1].children.length,0);
 for(let n=0;n<100;n++)h.run("applyEvent({payload:{event:{type:'message_update',stream:'delta',message:m,deltaText:'x'}}});scheduleTranscript()");const frames=[...h.timers].filter(([,timer])=>timer.time===16);assert.equal(frames.length,1);h.timers.delete(frames[0][0]);frames[0][1].run();assert.equal(h.get("transcript").children[0],fixed);assert.equal(h.get("transcript").children.find(n=>n.dataset.item==="burst"),live);assert.equal(live.querySelectorAll("p")[0].textContent,"x".repeat(100));detail.open=true;await detail.emit("toggle");assert.ok(detail.textContent.includes('"content": "'+"x".repeat(100)+'"'));
});

test("model wait, runtime phases, streaming output and elapsed time use actual turn events",async()=>{
 const h=harness();await h.pair();await h.open();h.ctx.testNow=Date.parse("2026-10-04T10:01:05Z");h.run("Date.now=()=>testNow;acceptTurn({id:'turn',status:'running',startedAt:'2026-10-04T10:00:00Z'});");assert.ok(h.get("activity").textContent.includes("Waiting for model"));assert.ok(h.get("activity").textContent.includes("1:05"));h.run("observeActivity({payload:{event:{type:'status',status:{isRunning:true,activity:{phase:'retrying',since:testNow}}}}})");assert.ok(h.get("activity").textContent.includes("Retrying"));h.run("observeActivity({payload:{event:{type:'message_update',deltaText:'Hello'}}})");assert.ok(h.get("activity").textContent.includes("Responding"));h.run("observeActivity({kind:'turn.completed',turnId:'turn'})");assert.equal(h.get("activity").textContent,"Ready");
});


test("backgrounding during approval never leaves the returning request disabled",async()=>{
 const h=harness();await h.pair();await h.open();h.snapshots.pendingApprovals=[{id:"background",summary:"Read",expiresAt:"2099-01-01",revision:1,allowedDecisions:["allow-once","deny"]}];await h.run("snapshot(state.generation)");let resolve;h.gateApproval(new Promise(r=>resolve=r));const card=h.get("requests").children[0];const button=card.querySelectorAll("button")[0];const pending=button.click();await h.flush();assert.equal(button.disabled,true);h.document.hidden=true;h.document.listeners.get("visibilitychange")();resolve(response({status:"resolved"}));await pending;await h.flush();assert.equal(card.dataset.pending,"false");assert.equal(button.disabled,false);h.document.hidden=false;h.document.listeners.get("visibilitychange")();await h.flush();assert.equal(h.get("requests").children[0].querySelectorAll("button")[0].disabled,false);
});
