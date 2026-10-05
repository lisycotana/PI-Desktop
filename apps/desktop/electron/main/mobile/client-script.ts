import { applyMessageUpdate } from "@pi-desktop/shared";
import { mobileCatalogScript } from "./client-i18n";
import { mobileControlsScript } from "./client-controls";
import { mobileRequestsScript } from "./client-requests";
import { mobileActivityScript } from "./client-activity";
import { mobileComposerSettingsScript } from "./client-composer-settings";
import { mobileRenderScript } from "./client-render";
import { mobileToolDisplayScript } from "./client-tool-display";
import { mobilePairingScript } from "./client-pairing";
import { mobileIcons } from "./client-icons";

/** The shared reducer is self-contained; serve its actual implementation. */
export const mobileScript = `"use strict";\nfunction consumePairingLink() {const value = location.hash ? location.href : "";if (value) history.replaceState(null,"",location.pathname + location.search);return value;}\nlet startupPairingLink = consumePairingLink();\nconst iconMarkup = ${JSON.stringify(mobileIcons)};\nconst applyMessageUpdate = ${applyMessageUpdate.toString()};\n${mobileCatalogScript}\n${mobileToolDisplayScript}\n${mobileRenderScript}\n${mobileComposerSettingsScript}\n${mobileControlsScript}\n${mobileRequestsScript}\n${mobileActivityScript}\n${mobilePairingScript}\n` + String.raw`
const el = id => document.getElementById(id);
const state = {csrf:"",current:null,cursor:null,generation:0,version:0,abort:null,retryTimer:null,snapshotTimer:null,items:[],live:new Map(),trace:[],snapshot:null,hasMore:false,refreshing:false,dirty:false,sending:false,capabilities:{controls:false},models:[],projects:[],sessions:[],drafts:new Map(),configs:new Map(),answers:new Map(),changes:null,preview:null,path:""};
document.querySelectorAll("[data-label]").forEach(n => n.textContent = t[n.dataset.label]);
document.querySelectorAll("[data-placeholder]").forEach(n => n.placeholder = t[n.dataset.placeholder]);
document.querySelectorAll("[data-aria]").forEach(n => n.setAttribute("aria-label",t[n.dataset.aria]));
const status = (key,live = false) => { el("connection").textContent = t[key]; el("connection").dataset.live = String(live); el("retry").dataset.live = String(live); el("retry").setAttribute("aria-label",t[key] + " · " + t.refresh); };
const desktopLayout = window.matchMedia("(min-width:768px)");
const themePreference = window.matchMedia("(prefers-color-scheme:light)");
function applyTheme() {document.documentElement.dataset.theme = themePreference.matches ? "light" : "dark";}
applyTheme();themePreference.addEventListener("change",applyTheme);
function setDrawer(open) {
 document.documentElement.dataset.drawer = open ? "open" : "closed";el("drawer-scrim").hidden = !open;
 el("back").setAttribute("aria-expanded",String(open));el("sessions").inert = !!state.current && !open && !desktopLayout.matches;
 if (open) el("search").focus();
}
desktopLayout.addEventListener("change",() => setDrawer(false));
function view(name) {el("pair").hidden = name !== "pair";el("sessions").hidden = name === "pair";el("conversation").hidden = name !== "conversation";el("empty-chat").hidden = name !== "sessions";document.documentElement.dataset.view = name;el("logout").hidden = name === "pair";setDrawer(false);}
function stop() { cancelTranscript();stopActivity();state.generation++; state.abort?.abort(); clearTimeout(state.retryTimer); clearTimeout(state.snapshotTimer); state.refreshing = false; state.dirty = false; state.abort = null; state.sending = false; for (const id of ["task-dialog","model-dialog"]) if (el(id).open) el(id).close(); el("session-menu").hidden = true;el("menu-toggle").setAttribute("aria-expanded","false"); }
function unpair(message) { stop(); state.csrf = ""; state.current = null; state.items = []; state.live.clear(); state.trace = []; state.snapshot = null; state.drafts.clear(); state.answers.clear(); state.configs.clear(); el("message").value = ""; clearTranscript(); clearRequests();el("session-list").replaceChildren(); view("pair");pairingScreen("start"); status("pairing"); el("pair-error").textContent = message || ""; }
async function api(path, options = {}) {
 const {quietAuth,text:plainText,blob:binary,timeoutMs = 30000,...init} = options; const abort = new AbortController(); const timer = setTimeout(() => abort.abort(),timeoutMs);
 try {
  const response = await fetch(path,{credentials:"same-origin",cache:"no-store",...init,signal:abort.signal,headers:{"X-PI-Origin":location.origin,...(options.method === "POST" ? {"X-PI-CSRF":state.csrf,"Content-Type":"application/json"} : {}),...options.headers}});
  if (response.status === 401) { if (!quietAuth) unpair(t.expired); throw new Error(t.expired); }
  if (!response.ok) { let message = t.actionFailed; let code; try { const body = await response.json(); message = body.error?.message || body.message || message; code = body.error?.code; } catch { /* Non-JSON errors use the localized fallback. */ } const error = new Error(message); if (code) error.code = code; throw error; }
  return binary ? {blob:await response.blob(),mime:response.headers.get("X-PI-Attachment-Type")} : plainText ? await response.text() : await response.json();
 } finally { clearTimeout(timer); }
}
function sessionStatus(session) { return session.status === "running" ? t.running : session.status === "waiting_permission" ? t.waiting : session.status === "error" ? t.failed : t.idle; }
function renderSessions() {
 const target = el("session-list"); target.replaceChildren(); const query = el("search").value.toLocaleLowerCase();
 const sessions = state.sessions.filter(s => [s.title,s.workspaceLabel].filter(Boolean).join(" ").toLocaleLowerCase().includes(query)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
 const groups = new Map(); for (const s of sessions) { const key = s.workspaceLabel || t.sessions; if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(s); }
 for (const [label,items] of groups) {
  const group=node("details",undefined,"session-group");group.open = !state.collapsedGroups?.has(label) || !!query;const summary=node("summary");summary.append(icon("chevronRight"),node("span",label));group.append(summary);
  group.addEventListener("toggle",()=>{state.collapsedGroups ||= new Set();if (group.open) state.collapsedGroups.delete(label);else state.collapsedGroups.add(label);});
  for (const s of items) {const row=button("",()=>open(s),"session-row");row.setAttribute("aria-current",String(s.id === state.current?.id));const heading=node("div",undefined,"row-heading");const indicator=node("span",undefined,"session-state");indicator.dataset.status=s.status;indicator.setAttribute("title",sessionStatus(s));indicator.setAttribute("aria-label",sessionStatus(s));indicator.append(icon(s.status === "error" ? "circleAlert" : s.status === "waiting_permission" ? "circleAlert" : s.status === "running" ? "bot" : "check"));heading.append(node("span",s.title || t.untitled,"session-title"),indicator);row.append(heading);group.append(row);}target.append(group);
 }
 if (!sessions.length) target.append(node("p",t.noSessions,"empty")); el("new-task").hidden = !state.capabilities.controls;
}
async function refreshSessions() {
 if (!state.current) {await list();return;}
 const generation=state.generation;try {const result=await api("/v1/sessions");if (generation === state.generation) {state.sessions=result.sessions;renderSessions();}}catch(error){if (generation === state.generation) el("list-error").textContent=error.message;}
}
async function list() {
 saveDraft(); stop(); state.current = null; view("sessions"); status("reconnecting"); showError(""); const generation = state.generation;
 try { const [result,capabilities] = await Promise.all([api("/v1/sessions"),api("/v1/capabilities")]); if (generation !== state.generation) return; state.sessions = result.sessions; state.capabilities = capabilities; view("sessions"); renderSessions(); status("connected",true);
  if (capabilities.controls) { const [models,projects] = await Promise.allSettled([api("/v1/models"),action("project/list")]); if (generation !== state.generation) return; if (models.status === "fulfilled") state.models = Array.isArray(models.value) ? models.value : models.value.models || []; else showError(models.reason.message); if (projects.status === "fulfilled") state.projects = projects.value.projects || []; else showError(projects.reason.message); }
 } catch (error) { if (generation === state.generation && state.csrf) { status("offline"); showError(error.message || t.error); } }
}
async function snapshot(generation) {
 const sessionId = state.current?.id; const version = state.version; if (!sessionId) return false;
 const result = await api("/v1/sessions/" + encodeURIComponent(sessionId) + ":attach",{method:"POST",body:"{}"});
 if (generation !== state.generation || state.current?.id !== sessionId) return false;
 if (result.session?.id !== sessionId || result.snapshot?.session?.id !== sessionId) throw new Error(t.error);
 state.snapshot = result.snapshot; state.current = {...state.current,...result.session};
 for (const item of [...(result.snapshot.items || []),...(result.snapshot.activeItems || [])]) { const m = normalizeItem(item); const live = state.live.get(m.id); if (live && live.version <= version) { const defined = Object.fromEntries(Object.entries(m).filter(([,v]) => v !== undefined)); state.live.set(m.id,{message:{...live.message,...defined},version}); } }
 el("conversation-title").textContent = state.current.title || t.untitled; updateActivity(); renderTranscript(); renderRequests(); return true;
}
function scheduleSnapshot(generation) {
 state.dirty = true; if (state.refreshing) return; state.refreshing = true;
 state.snapshotTimer = setTimeout(async () => { state.dirty = false; try { await snapshot(generation); } catch (error) { if (generation === state.generation && state.csrf) { status("reconnecting"); showError(error.message); } } finally { if (generation === state.generation) { state.refreshing = false; if (state.dirty) scheduleSnapshot(generation); } } },250);
}
async function follow(generation,refresh = false) {
 if (generation !== state.generation || document.hidden || !state.current) return; state.abort?.abort(); clearTimeout(state.retryTimer); const streamAbort = new AbortController(); state.abort = streamAbort;
 try {
  if (refresh && !await snapshot(generation)) return;
  const response = await fetch("/v1/sessions/" + encodeURIComponent(state.current.id) + "/events",{credentials:"same-origin",cache:"no-store",signal:streamAbort.signal,headers:{"X-PI-Origin":location.origin,...(state.cursor ? {"Last-Event-ID":state.cursor.epoch + ":" + state.cursor.sequence} : {})}});
  if (generation !== state.generation) { await response.body?.cancel(); return; } if (response.status === 401) { unpair(t.expired); return; } if (!response.ok || !response.body) throw new Error(t.error); status("connected",true);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  while (generation === state.generation) { const chunk = await reader.read(); if (chunk.done) break; if (generation !== state.generation) { await reader.cancel(); return; } buffer += decoder.decode(chunk.value,{stream:true}).replace(/\r\n/g,"\n"); if (buffer.length > 2 * 1024 * 1024) throw new Error(t.actionFailed); let boundary;let frames = 0;
   while ((boundary = buffer.indexOf("\n\n")) >= 0) { const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary + 2); const lines = frame.split("\n"); const kind = lines.find(l => l.startsWith("event: "))?.slice(7); const data = lines.filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
    if (kind === "resync") { if (await snapshot(generation)) state.cursor = state.snapshot.cursor; }
    if (kind === "racp" && data) { const envelope = JSON.parse(data); observeActivity(envelope);observeRequests(envelope);if (applyEvent(envelope)) scheduleTranscript(); if (!["item.delta","tool.progress","turn.activity"].includes(envelope.kind)) scheduleSnapshot(generation); }
    if (++frames % 32 === 0) await new Promise(resolve => setTimeout(resolve,0));
   }
  }
 } catch (error) { if (generation === state.generation && !document.hidden && state.csrf && error.name !== "AbortError") showError(error.message || t.error); }
 if (generation !== state.generation || document.hidden || !state.csrf || state.abort !== streamAbort) return; status("reconnecting"); state.retryTimer = setTimeout(() => follow(generation,true),2000);
}
async function open(session) {
 setDrawer(false);
 saveDraft(); stop(); state.current = session; state.snapshot = null; state.items = []; state.live.clear(); state.trace = []; state.cursor = null; state.version = 0; state.hasMore = false; state.changes = null; state.preview = null;state.reviews = null;el("review-records").replaceChildren();el("review-more").hidden = true;el("reviews-error").textContent = "";
 if (!state.drafts.has(session.id)) state.drafts.set(session.id,{text:"",attachments:[],pending:null,model:session.providerId && session.modelId ? modelKey({providerId:session.providerId,id:session.modelId}) : "",thinking:session.thinkingLevel || ""}); const draft = state.drafts.get(session.id);
 el("message").value = draft.text; modelOptions(el("model"),draft.model); thinkingOptions(el("thinking"),selectedModel(el("model")),draft.thinking); restoreComposerSettings();renderAttachments(); updateComposer(); clearTranscript(); clearRequests(); el("diff-files").replaceChildren(); el("workspace-files").replaceChildren(); el("file-content").replaceChildren(); el("conversation-title").textContent = session.title || t.untitled; showError(""); taskTab("task"); view("conversation");renderSessions(); status("reconnecting"); const generation = state.generation;
 try { if (state.capabilities.sessionConfiguration && !state.configs.has(session.id)) { const config = await api("/v1/sessions/" + encodeURIComponent(session.id) + "/configuration"); if (generation !== state.generation) return; state.configs.set(session.id,JSON.stringify(config)); if (!draft.model) { draft.model = config.providerId && config.modelId ? modelKey({providerId:config.providerId,id:config.modelId}) : ""; draft.thinking = config.thinkingLevel || ""; modelOptions(el("model"),draft.model); thinkingOptions(el("thinking"),selectedModel(el("model")),draft.thinking); } } const history = await api("/v1/sessions/" + encodeURIComponent(session.id) + "/history"); if (generation !== state.generation) return; state.items = history.items; state.hasMore = history.hasMore; if (!await snapshot(generation)) return; state.cursor = state.snapshot.cursor; el("transcript-scroll").scrollTop = el("transcript-scroll").scrollHeight; void follow(generation); }
 catch (error) { if (generation === state.generation && state.csrf) { status("offline"); showError(error.message || t.error); } }
}
initPairing();initComposerSettings();
el("logout").addEventListener("click",async () => { try { await api("/v1/browser/logout",{method:"POST",body:"{}"}); unpair(); } catch (error) { status("offline"); showError(error.message); } });
el("home").addEventListener("click",list);
el("refresh").addEventListener("click",refreshSessions);el("back").addEventListener("click",() => setDrawer(true));el("drawer-close").addEventListener("click",() => setDrawer(false));el("drawer-scrim").addEventListener("click",() => {setDrawer(false);el("back").focus();});el("start-task").addEventListener("click",() => dialog("newTask")); el("search").addEventListener("input",renderSessions); el("new-task").addEventListener("click",() => dialog("newTask"));
el("retry").addEventListener("click",() => state.current && open(state.current));
el("more").addEventListener("click",async () => { const generation = state.generation; const sessionId = state.current?.id; const first = state.items[0]?.id; if (!sessionId || !first) return; el("more").disabled = true; try { const history = await api("/v1/sessions/" + encodeURIComponent(sessionId) + "/history",{headers:{"X-PI-History-Before":first}}); if (generation === state.generation) { const items = new Map([...history.items,...state.items].map(i => [i.id,i])); state.items = [...items.values()]; state.hasMore = history.hasMore; renderTranscript(); } } catch (error) { if (generation === state.generation) showError(error.message || t.error); } finally { if (generation === state.generation) el("more").disabled = false; } });
el("composer").addEventListener("submit",event => { event.preventDefault(); void sendMessage(); }); el("message").addEventListener("input",() => {saveDraft();updateComposer();});
el("model").addEventListener("change",() => {thinkingOptions(el("thinking"),selectedModel(el("model")));saveDraft();updateComposer();renderModelMenu();void configureModel();}); el("thinking").addEventListener("change",() => {saveDraft();updateComposer();void configureModel();}); el("model-search").addEventListener("input",renderModelMenu);
el("model-toggle").addEventListener("click",() => {el("model-error").textContent = "";renderModelMenu();el("model-dialog").showModal();el("model-search").focus();}); el("model-close").addEventListener("click",() => el("model-dialog").close());
el("jump-latest").addEventListener("click",() => {el("transcript-scroll").scrollTop = el("transcript-scroll").scrollHeight;});
el("transcript-scroll").addEventListener("scroll",() => {const scroll = el("transcript-scroll");el("jump-latest").hidden = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;});
el("attach").addEventListener("click",() => el("attachment-input").click()); el("attachment-input").addEventListener("change",() => {const files = [...el("attachment-input").files]; el("attachment-input").value = ""; void uploadFiles(files);});
for (const method of ["stop","interrupt"]) el(method).addEventListener("click",() => {const turnId = state.snapshot?.activeTurn?.id; if (turnId) void mutate("turn/" + method,{turnId});});
el("task-tab").addEventListener("click",() => taskTab("task")); el("changes-tab").addEventListener("click",() => {taskTab("changes");void loadChanges();}); el("changes-refresh").addEventListener("click",() => loadChanges()); el("review-more").addEventListener("click",() => loadReviews(true)); el("diff-more").addEventListener("click",() => loadChanges(true));
el("workspace-form").addEventListener("submit",event => {event.preventDefault();const path = el("workspace-path").value.trim();if (path && !isWorkspacePath(path)) {el("changes-error").textContent = t.actionFailed;return;} void browseWorkspace(path);});
el("download-trace").addEventListener("click",() => download("pi-task-trace.json",raw({session:state.current,messages:messages(),events:state.trace}),"application/json"));
for (const kind of ["rename","fork","compact","delete"]) el(kind).addEventListener("click",() => dialog(kind));
el("menu-toggle").addEventListener("click",() => {el("session-menu").hidden = !el("session-menu").hidden;el("menu-toggle").setAttribute("aria-expanded",String(!el("session-menu").hidden));});
document.addEventListener("keydown",event => {if (event.key === "Escape") {setDrawer(false);el("session-menu").hidden = true;el("menu-toggle").setAttribute("aria-expanded","false");}});
document.addEventListener("visibilitychange",() => {if (!state.current) return;if (document.hidden) {saveDraft();stop();status("reconnecting");} else {const generation = state.generation;void snapshot(generation).then(ok => ok && follow(generation)).catch(error => {status("offline");showError(error.message);});}});
window.addEventListener("online",() => {if (state.current && !document.hidden) {const generation = state.generation;void snapshot(generation).then(ok => ok && follow(generation)).catch(error => showError(error.message));} else if (state.csrf) void list();});
view("pair"); status("pairing"); if (startupPairingLink) {const value = startupPairingLink;startupPairingLink = "";void pairFromLink(value);}else api("/v1/browser/session",{quietAuth:true}).then(result => {state.csrf = result.csrf;return list();}).catch(() => {});
window.addEventListener("hashchange",() => {const value = consumePairingLink();if (value) {unpair();void pairFromLink(value);}});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (window.visualViewport) { const fit = () => {document.documentElement.style.setProperty("--app-height",window.visualViewport.height + "px");document.documentElement.style.setProperty("--viewport-top",window.visualViewport.offsetTop + "px");}; window.visualViewport.addEventListener("resize",fit);window.visualViewport.addEventListener("scroll",fit);fit(); }
`;
