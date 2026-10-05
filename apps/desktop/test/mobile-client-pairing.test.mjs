import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import test from "node:test";

register(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),"helpers/ts-import-hooks.mjs")));
const {mobilePairingScript} = await import("../electron/main/mobile/client-pairing.ts");
const {newPairingToken} = await import("@pi-desktop/racp");
const tick = async () => {for (let n=0;n<8;n++) await new Promise(setImmediate);};
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function harness() {
 const elements = new Map();const calls=[];const timers=[];const complete=deferred();let listed=0;let stopped=0;
 const now=Date.parse("2026-10-04T08:00:00Z");
 class Clock extends Date {static now(){return now;}}
 const t={showCode:"显示配对码",hideCode:"隐藏配对码",pairInvalid:"配对码无效或已过期",pairExpired:"配对请求已超时",pairOriginMismatch:"二维码不属于此桌面",pairCancelled:"已取消配对",pairRejected:"电脑拒绝了配对",defaultDevice:"手机浏览器",cameraDenied:"摄像头权限未允许",cameraMissing:"未找到摄像头"};
 const el=id=>{if (!elements.has(id)) elements.set(id,{value:"",type:"password",textContent:"",hidden:false,disabled:false,videoWidth:640,videoHeight:480,readyState:2,listeners:new Map(),setAttribute(name,value){this[name]=value;},replaceChildren(...children){this.children=children;},addEventListener(event,handler){this.listeners.set(event,handler);},focus(){this.focused=true;},async play(){}});return elements.get(id);};
 const pending={requestId:"request",secret:"completion",verificationCode:"806981",expiresAt:new Date(now+120000).toISOString(),status:"pending"};
 const api=async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});if(path.endsWith("/pair"))return pending;if(path.endsWith("/complete"))return complete.promise;if(path.endsWith("/cancel"))return {status:"cancelled"};throw new Error(path);};
 const payload=JSON.stringify({kind:"pi-mobile-pairing",version:1,origin:"https://pi.example",token:"test-qr",expiresAt:new Date(now+60000).toISOString()});
 const ctx=createContext({Date:Clock,t,el,api,icon:name=>name,URL,URLSearchParams,state:{generation:0,csrf:""},location:{origin:"https://pi.example"},window:{addEventListener(){},jsQR:()=>({data:payload})},navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++;}}]})}},document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(4)})})})},Uint8ClampedArray,setTimeout:(resolve,ms)=>{timers.push({resolve,ms});},list:async()=>{listed++;},console});
 new Script(mobilePairingScript+"\ninitPairing();").runInContext(ctx);
 const run=code=>new Script(code).runInContext(ctx);
 return {ctx,el,calls,timers,complete,pending,run,tick,listed:()=>listed,stopped:()=>stopped};
}

test("manual pairing retains a rejected code and localizes the protocol failure",async()=>{
 const h=harness();h.el("pair-manual").listeners.get("click")();assert.equal(h.el("pair-form").hidden,false);assert.equal(h.el("pair-start").hidden,true);
 h.ctx.api=async()=>{throw Object.assign(new Error("pairing is invalid, expired, or already used"),{code:"PAIRING_FAILED"});};h.el("code").value="expired-code";
 await h.run("pairBrowser({preventDefault(){}})");assert.equal(h.el("pair-error").textContent,"配对码无效或已过期");assert.equal(h.el("code").value,"expired-code");assert.equal(h.el("pair-form").hidden,false);
 h.el("pair-form-close").listeners.get("click")();assert.equal(h.el("code").value,"");assert.equal(h.el("pair-start").hidden,false);
});

test("a QR from another desktop never starts an authentication request",()=>{
 const h=harness();h.ctx.qr=JSON.stringify({kind:"pi-mobile-pairing",version:1,origin:"https://other.example",token:"token",expiresAt:h.pending.expiresAt});assert.throws(()=>h.run("pairingToken(qr)"),/二维码不属于此桌面/);assert.equal(h.calls.length,0);
});

test("scanning begins pairing directly and releases the camera before desktop approval",async()=>{
 const h=harness();const scanning=h.run("scanPairingQr()");await h.tick();assert.equal(h.calls[0].body.token,"test-qr");assert.equal(h.stopped(),1);assert.equal(h.el("qr-reader").hidden,true);assert.equal(h.el("pair-pending").hidden,false);assert.equal(h.el("pair-countdown").textContent,"2:00");assert.equal(h.el("pair-verification").textContent,"806981");h.complete.resolve({status:"approved",csrf:"csrf"});await scanning;assert.equal(h.listed(),1);assert.equal(h.ctx.state.csrf,"csrf");
});

test("cancel during completion invalidates the request and never opens an approved session",async()=>{
 const h=harness();h.el("code").value="test-token";const pairing=h.run("pairBrowser()");await h.tick();const cancelling=h.run("cancelPairing()");await h.tick();assert.equal(h.calls.some(c=>c.path.endsWith("/cancel")),false);
 h.complete.resolve({status:"approved",csrf:"late-csrf"});await Promise.all([pairing,cancelling]);assert.equal(h.listed(),0);assert.equal(h.ctx.state.csrf,"");assert.deepEqual(h.calls.at(-1).body,{requestId:"request",secret:"completion"});assert.equal(h.calls.at(-1).path,"/v1/browser/pair/cancel");assert.equal(h.el("pair-error").textContent,"已取消配对");assert.equal(h.el("pair-start").hidden,false);
});

test("cancel still reaches the server when completion delivery fails",async()=>{
 const h=harness();h.ctx.api=async(path,options)=>{h.calls.push({path,body:JSON.parse(options.body)});if(path.endsWith("/pair"))return h.pending;if(path.endsWith("/complete"))return h.complete.promise.then(()=>{throw new Error("Network disconnected");});return {status:"cancelled"};};h.el("code").value="test-token";const pairing=h.run("pairBrowser()");await h.tick();const cancelling=h.run("cancelPairing()");h.complete.resolve();await Promise.all([pairing,cancelling]);assert.equal(h.calls.at(-1).path,"/v1/browser/pair/cancel");assert.equal(h.listed(),0);assert.equal(h.el("pair-error").textContent,"已取消配对");
});

test("website links validate exact origin and fragment while legacy input remains supported",()=>{
 const h=harness();const expires=h.pending.expiresAt;h.ctx.value="https://pi.example/#"+new URLSearchParams({pair:"test-code",expires});assert.equal(h.run("pairingToken(value)"),"test-code");
 const hostToken=newPairingToken();h.ctx.value="https://pi.example/#"+new URLSearchParams({pair:hostToken,expires});assert.equal(h.run("pairingToken(value)"),hostToken);
 for(const value of ["https://other.example/#pair=test-code&expires="+expires,"https://pi.example/other#pair=test-code&expires="+expires,"https://pi.example/?pair=test-code#expires="+expires,"https://pi.example/#pair=a&pair=b&expires="+expires,"https://pi.example/#pair=a&expires="+expires+"&extra=1","https://user@pi.example/#pair=a&expires="+expires,"https://pi.example/#pair=%ZZ&expires="+expires,"https://pi.example/#pair=a&expires=2000-01-01"]) {h.ctx.value=value;assert.throws(()=>h.run("pairingToken(value)"));}
 h.ctx.value=JSON.stringify({kind:"pi-mobile-pairing",version:1,origin:"https://pi.example",token:"legacy-code",expiresAt:expires});assert.equal(h.run("pairingToken(value)"),"legacy-code");h.ctx.value="manual-code";assert.equal(h.run("pairingToken(value)"),"manual-code");assert.equal(h.calls.length,0);
});

test("the code visibility button preserves the value and resets when leaving manual entry",()=>{
 const h=harness();h.el("pair-manual").listeners.get("click")();h.el("code").value="test-code";const toggle=h.el("code-visibility").listeners.get("click");toggle();assert.equal(h.el("code").type,"text");assert.equal(h.el("code").value,"test-code");assert.equal(h.el("code-visibility")["aria-label"],"隐藏配对码");toggle();assert.equal(h.el("code").type,"password");toggle();h.el("pair-form-close").listeners.get("click")();assert.equal(h.el("code").type,"password");assert.equal(h.el("code").value,"");
});
