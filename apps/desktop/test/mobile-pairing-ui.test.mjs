import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("esbuild");
const harness = {
  windows: [], dialogs: [], menus: [], qrInputs: [], answer: 0, dialogGate: null, qrGate: null,
  copied: [], clipboard: {writeText(value) {harness.copied.push(value);}},
  app: { isPackaged: false, getAppPath: () => join(tmpdir(), "pi-pairing-test-no-resources") },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: { async showMessageBox(...args) { harness.dialogs.push(args.at(-1)); return harness.dialogGate ? harness.dialogGate : { response: harness.answer }; } },
  Menu: { buildFromTemplate(template) { const menu = { template, popup(options) { this.callback = options.callback; options.callback?.(); }, closePopup() { this.callback?.(); } }; harness.menus.push(menu); return menu; } },
};
harness.BrowserWindow = class extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.destroyed = false; this.scripts = []; this.shown = false;
    this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
    this.webContents.session = { setPermissionRequestHandler: handler => { this.permissionRequest = handler; }, setPermissionCheckHandler: handler => { this.permissionCheck = handler; } };
    this.elements = new Map(["origin", "qr", "pairing-code", "expiry", "status", "brand-icon", "code-visibility"].map(id => [id, {hidden: false, value: "", textContent: "", setAttribute(name,value) {this[name]=value;}, removeAttribute(name) {delete this[name];}, select() {}}]));
    this.context = createContext({document: {getElementById: id => this.elements.get(id)}});
    this.webContents.executeJavaScript = async script => { this.scripts.push(script); return runInContext(script, this.context); };
    harness.windows.push(this);
  }
  setMenu(menu) { this.menu = menu; }
  async loadURL(url) { this.url = url; }
  isDestroyed() { return this.destroyed; }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  destroy() { this.destroyed = true; this.emit("closed"); }
};
globalThis.__pairingHarness = harness;

const result = await build({
  entryPoints: [fileURLToPath(new URL("../electron/main/mobile/pairing-ui.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
  banner: {js:'import { createRequire as nativeTestRequire } from "node:module";const require = nativeTestRequire(import.meta.url);'},
  plugins: [{ name: "pairing-ui-external-boundaries", setup(builder) {
    builder.onResolve({ filter: /^(electron|qrcode)$/ }, args => ({ path: args.path, namespace: "pairing-ui-test" }));
    builder.onLoad({ filter: /.*/, namespace: "pairing-ui-test" }, args => ({ contents: args.path === "electron"
      ? "const h=globalThis.__pairingHarness;export const app=h.app;export const BrowserWindow=h.BrowserWindow;export const clipboard=h.clipboard;export const dialog=h.dialog;export const Menu=h.Menu;export const nativeTheme=h.nativeTheme;"
      : "export default {async toDataURL(input,options){const h=globalThis.__pairingHarness;h.qrInputs.push({input,options});if(h.qrGate)await h.qrGate;return 'data:image/png;base64,ZmFrZS1xci1maXh0dXJl';}};" }));
  } }],
});
const directory = await mkdtemp(join(tmpdir(), "pi-pairing-ui-test-"));
after(() => rm(directory, { recursive: true, force: true }));
const entry = join(directory, "pairing-ui.mjs"); await writeFile(entry,result.outputFiles[0].text);
const { createMobilePairingUi, mobilePairingQrPayload, mobilePairingConfirmationOptions } = await import(pathToFileURL(entry).href);

function fixture(t, { locale = "en-US" } = {}) {
  harness.windows = []; harness.dialogs = []; harness.menus = []; harness.qrInputs = []; harness.answer = 0; harness.dialogGate = null; harness.qrGate = null;
  harness.copied = [];
  const parent = new EventEmitter(); parent.destroyed = false; parent.isDestroyed = () => parent.destroyed;
  const browser = { id: "browser-fixture-id", label: "Fixture phone", createdAt: "2026-10-04T00:00:00Z", expiresAt: "2026-10-04T08:00:00Z" };
  let issue = 0; let info = { origin: "https://desktop.example.ts.net", token: "fixture-pairing-code", expiresAt: new Date(Date.now() + 120000).toISOString() };
  const revoked = [];
  const service = {
    getPairing: () => info,
    issuePairing() { info = { ...info, token: `fixture-pairing-code-${++issue}`, expiresAt: new Date(Date.now() + 120000).toISOString() }; return info; },
    listBrowsers: () => [browser],
    revokeBrowser(id) { revoked.push(id); return true; },
  };
  const state = { service };
  const ui = createMobilePairingUi({ getService: () => state.freshFacade && state.service ? { ...state.service, issuePairing: async () => state.service.issuePairing() } : state.service, getMainWindow: () => parent, getLocale: () => locale });
  t.after(() => ui.close());
  const request = overrides => ({ origin: info.origin, label: "Fixture phone", userAgent: "Fixture browser", verificationCode: "123456", expiresAt: new Date(Date.now() + 60000).toISOString(), roles: ["viewer", "controller", "approver"], ...overrides });
  return { ui, service, state, parent, browser, revoked, request, info: () => info };
}

test("QR opens the exact origin with a one-use fragment and confirmation defaults to rejection", () => {
  const info = { origin: "https://desktop.example.ts.net", token: "fixture-code", expiresAt: "2026-10-04T08:00:00Z" };
  const url = new URL(mobilePairingQrPayload(info));assert.equal(url.origin,info.origin);assert.equal(url.pathname,"/");assert.equal(url.search,"");assert.equal(new URLSearchParams(url.hash.slice(1)).get("pair"),info.token);assert.equal(new URLSearchParams(url.hash.slice(1)).get("expires"),info.expiresAt);
  assert.throws(() => mobilePairingQrPayload({ ...info, origin: "https://desktop.example.ts.net/?token=fixture-code" }));
  assert.throws(() => mobilePairingQrPayload({ ...info, origin: "https://user:password@desktop.example.ts.net" }));
  const options = mobilePairingConfirmationOptions({ origin: info.origin, label: "Phone\nVerification code: 000000", userAgent: "Browser\u2028Spoofed line", verificationCode: "123456", expiresAt: info.expiresAt, roles: ["viewer","controller","approver"] },"en-US");
  assert.equal(options.defaultId,0); assert.equal(options.cancelId,0); assert.equal(options.buttons[0],"Reject"); assert.ok(options.detail.includes("(unverified)")); assert.ok(options.detail.includes('"Phone\\nVerification code: 000000"')); assert.ok(options.detail.includes("\\u2028")); assert.ok(options.detail.includes(info.origin));
});

test("pairing window never places credentials in its URL and has a sandbox, local QR, and denied navigation/permissions", async t => {
  const f = fixture(t); await f.ui.showPairing(); const window = harness.windows[0]; const info = f.info();
  assert.equal(window.options.webPreferences.sandbox,true); assert.equal(window.options.webPreferences.contextIsolation,true); assert.equal(window.options.webPreferences.nodeIntegration,false); assert.equal(window.options.webPreferences.webviewTag,false); assert.equal(window.options.webPreferences.devTools,false); assert.ok(!window.options.webPreferences.partition.startsWith("persist:"));
  assert.ok(!window.url.includes(info.token)); assert.ok(!decodeURIComponent(window.url).includes(info.token)); const html = decodeURIComponent(window.url.split(",").slice(1).join(",")); assert.match(html,/default-src 'none'/); assert.match(html,/script-src 'none'/); assert.match(html,/img-src data:/); assert.match(html,/type="password" readonly/); assert.doesNotMatch(html,/<script/);assert.deepEqual([...html.matchAll(/href="([^"]+)"/g)].map(match=>match[1]),["https://pairing-action.invalid/toggle-code","https://pairing-action.invalid/copy-code","https://pairing-action.invalid/copy-link","https://pairing-action.invalid/new-code"]);
  assert.equal(harness.qrInputs[0].input,mobilePairingQrPayload(info)); assert.equal(harness.qrInputs[0].options.errorCorrectionLevel,"M"); assert.ok(window.scripts[0].includes(JSON.stringify(info.token))); assert.ok(window.scripts[0].includes(JSON.stringify(info.origin))); assert.equal(window.shown,true);
  assert.deepEqual(window.openHandler(),{action:"deny"}); let denied; window.permissionRequest(null,"camera",value => {denied = value;}); assert.equal(denied,false); assert.equal(window.permissionCheck(),false); let prevented = false; window.webContents.emit("will-navigate",{preventDefault(){prevented = true;}}); assert.equal(prevented,true);
  await f.ui.showPairing(); assert.equal(harness.windows.length,1); assert.equal(harness.qrInputs.length,1);
});

test("confirmation grants task control only through an explicit current matching-origin approval", async t => {
  const f = fixture(t); assert.equal(await f.ui.confirmPairing(f.request()),false); harness.answer = 1; assert.deepEqual(await f.ui.confirmPairing(f.request()),{approved:true,taskControl:{maxPermissionMode:"auto",allowSessionGrants:true}});
  const before = harness.dialogs.length; assert.equal(await f.ui.confirmPairing(f.request({origin:"https://other.example"})),false); assert.equal(await f.ui.confirmPairing(f.request({verificationCode:"12x456"})),false); assert.equal(await f.ui.confirmPairing(f.request({roles:["owner"]})),false); assert.equal(await f.ui.confirmPairing(f.request({expiresAt:new Date(Date.now() - 1).toISOString()})),false); assert.equal(harness.dialogs.length,before);
});

test("bootstrap facades may be recreated and asynchronous QR rotation still opens the correct window", async t => {
  const f = fixture(t); f.state.freshFacade = true; await f.ui.showPairing(); assert.equal(harness.windows.length,1); assert.equal(harness.windows[0].shown,true); harness.answer = 1; assert.equal((await f.ui.confirmPairing(f.request())).approved,true);
});

test("expiry clears QR/password and cannot grant even if a late native dialog response says approve", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture(t); await f.ui.showPairing(); let resolve; harness.dialogGate = new Promise(r => {resolve = r;}); const pending = f.ui.confirmPairing(f.request({expiresAt:new Date(Date.now() + 30000).toISOString()})); const options = harness.dialogs.at(-1); t.mock.timers.tick(30001); assert.equal(options.signal.aborted,true); resolve({response:1}); assert.equal(await pending,false);
  assert.equal(harness.windows[0].isDestroyed(),true);
});

test("a rejected consumed code is removed and reopening immediately issues a fresh QR", async t => {
  const f = fixture(t); await f.ui.showPairing(); const original = f.info().token;
  assert.equal(await f.ui.confirmPairing(f.request()),false);
  assert.equal(harness.windows[0].isDestroyed(),true);
  await f.ui.showPairing(); assert.notEqual(f.info().token,original);
  assert.equal(harness.windows[1].shown,true);
});

test("an unused expired QR clears its credential material", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture(t); await f.ui.showPairing(); t.mock.timers.tick(120001);
  const script = harness.windows[0].scripts.at(-1);
  assert.ok(script.includes('pairing-code").value=""')); assert.ok(script.includes('qr").hidden=true'));
});

test("the expired window renews only through its exact intercepted local action", async t => {
  t.mock.timers.enable({apis:["Date","setTimeout"],now:Date.parse("2026-10-04T00:00:00Z")});
  const f=fixture(t);await f.ui.showPairing();const window=harness.windows[0];const old=f.info().token;t.mock.timers.tick(120001);
  for (const url of ["https://evil.example/","https://pairing-action.invalid/new-code?x=1","file:///secret"]) {let prevented=false;window.webContents.emit("will-navigate",{preventDefault(){prevented=true;}},url);assert.equal(prevented,true);assert.equal(f.info().token,old);}
  let prevented=false;window.webContents.emit("will-navigate",{preventDefault(){prevented=true;}},"https://pairing-action.invalid/new-code");assert.equal(prevented,true);await new Promise(setImmediate);assert.equal(harness.windows.length,1);assert.equal(window.isDestroyed(),false);assert.notEqual(f.info().token,old);assert.equal(harness.qrInputs.length,2);assert.ok(window.scripts.some(script=>script.includes('qr.hidden=false')));
  assert.equal(window.elements.get("pairing-code").value, f.info().token);assert.equal(window.elements.get("qr").hidden,false);assert.equal(window.elements.get("status").textContent,"");
  window.webContents.emit("will-navigate",{preventDefault(){}},"https://pairing-action.invalid/new-code");await new Promise(setImmediate);
  assert.equal(window.elements.get("pairing-code").value,f.info().token);assert.equal(window.elements.get("status").textContent,"");assert.equal(harness.qrInputs.length,3);
  window.destroy();const current=f.info().token;window.webContents.emit("will-navigate",{preventDefault(){}},"https://pairing-action.invalid/new-code");await new Promise(setImmediate);assert.equal(f.info().token,current);
});

test("a cancelled browser request aborts the native approval and blocks a late approve click",async t=>{
  const f=fixture(t);const controller=new AbortController();let resolve;harness.dialogGate=new Promise(r=>{resolve=r;});const result=f.ui.confirmPairing(f.request({signal:controller.signal}));controller.abort();assert.equal(harness.dialogs.at(-1).signal.aborted,true);resolve({response:1});assert.equal(await result,false);
});

test("parent close, service replacement, and factory shutdown cancel outstanding approvals", async t => {
  const f = fixture(t); let resolve; harness.dialogGate = new Promise(r => {resolve = r;}); let pending = f.ui.confirmPairing(f.request()); f.parent.destroyed = true; f.parent.emit("closed"); assert.equal(harness.dialogs.at(-1).signal.aborted,true); resolve({response:1}); assert.equal(await pending,false);
  f.parent.destroyed = false; harness.dialogGate = new Promise(r => {resolve = r;}); pending = f.ui.confirmPairing(f.request()); f.state.service = { ...f.service, getPairing: () => f.info() }; resolve({response:1}); assert.equal(await pending,false);
  f.state.service = f.service; harness.dialogGate = new Promise(r => {resolve = r;}); pending = f.ui.confirmPairing(f.request()); f.ui.close(); assert.equal(harness.dialogs.at(-1).signal.aborted,true); resolve({response:1}); assert.equal(await pending,false);
});

test("browser metadata menu revokes only its explicitly confirmed id and contains no pairing token", async t => {
  const f = fixture(t,{locale:"zh-CN"}); await f.ui.showSessions(); const menu = harness.menus[0]; assert.ok(JSON.stringify(menu.template).includes("Fixture phone")); assert.ok(!JSON.stringify(menu.template).includes(f.info().token));
  const revoke = menu.template[0].submenu.at(-1); revoke.click(); await new Promise(setImmediate); assert.deepEqual(f.revoked,[]); assert.equal(harness.dialogs.at(-1).cancelId,0); assert.equal(harness.dialogs.at(-1).buttons[0],"取消");
  harness.answer = 1; revoke.click(); await new Promise(setImmediate); assert.deepEqual(f.revoked,[f.browser.id]); assert.ok(harness.dialogs.at(-1).message.includes("已撤销"));
});

test("visibility and clipboard controls use only the live native pairing window", async t => {
  t.mock.timers.enable({apis:["Date","setTimeout"],now:Date.parse("2026-10-04T00:00:00Z")});
  const f=fixture(t);await f.ui.showPairing();const window=harness.windows[0];
  const action=async name=>{let blocked=false;window.webContents.emit("will-navigate",{preventDefault(){blocked=true;}},"https://pairing-action.invalid/"+name);assert.equal(blocked,true);await new Promise(setImmediate);};
  assert.equal(window.elements.get("pairing-code").type,"password");await action("toggle-code");assert.equal(window.elements.get("pairing-code").type,"text");assert.equal(window.elements.get("code-visibility")["aria-pressed"],"true");await action("toggle-code");assert.equal(window.elements.get("pairing-code").type,"password");
  await action("copy-code");await action("copy-link");assert.deepEqual(harness.copied,[f.info().token,mobilePairingQrPayload(f.info())]);assert.equal(window.elements.get("status").textContent,"Link copied");
  await action("copy-code?value=other");assert.equal(harness.copied.length,2);
  let release;harness.qrGate=new Promise(resolve=>{release=resolve;});await action("new-code");await action("copy-code");assert.equal(harness.copied.length,2);release();await new Promise(setImmediate);harness.qrGate=null;
  await action("copy-code");assert.equal(harness.copied.at(-1),f.info().token);assert.equal(window.elements.get("pairing-code").type,"password");
  t.mock.timers.tick(120001);await action("copy-code");assert.equal(harness.copied.length,3);assert.equal(window.elements.get("pairing-code").value,"");assert.equal(window.elements.get("qr").hidden,true);
  window.destroy();await action("copy-link");assert.equal(harness.copied.length,3);
});
