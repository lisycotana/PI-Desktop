/** Mobile interactions route only canonical RACP operations. */
export const mobileControlsScript = String.raw`
function context(revision) { return { requestId:crypto.randomUUID(), ...(revision === undefined ? {} : {expectedRevision:revision}) }; }
async function action(method, params = {}) { return api("/v1/action", {method:"POST",body:JSON.stringify({method,params})}); }
function showError(message) { el(state.current ? "conversation-error" : "list-error").textContent = message || ""; if (el("model-dialog").open) el("model-error").textContent = message || ""; }
async function mutate(method, params, after) {
 const generation = state.generation; const sessionId = state.current?.id; showError("");
 try { const result = await action(method, params); if (generation !== state.generation || sessionId !== state.current?.id) return; if (after) await after(result); else if (state.current) await snapshot(generation); }
 catch (error) { if (generation === state.generation) showError(error.message || t.actionFailed); }
}
function selectedModel(select) { return state.models.find(m => modelKey(m) === select.value); }
function modelKey(model) { return model.providerId + ":" + (model.id || model.modelId); }
function modelOptions(select, value = "") {
 select.replaceChildren(); const empty = node("option", t.defaultModel); empty.value = ""; select.append(empty);
 for (const m of state.models) { const option = node("option", m.name || m.id || m.modelId); option.value = modelKey(m); select.append(option); } select.value = value; if (!select.value) select.value = ""; renderModelMenu();
}
function renderModelMenu() {
 const target = el("model-list"); target.replaceChildren(); const query = el("model-search").value.trim().toLocaleLowerCase(); const groups = new Map();
 for (const model of state.models) { const label = model.name || model.id || model.modelId; if (query && !String(label).toLocaleLowerCase().includes(query) && !String(model.providerId).toLocaleLowerCase().includes(query)) continue; const group = groups.get(model.providerId) || []; group.push(model); groups.set(model.providerId, group); }
 for (const [provider, models] of groups) { target.append(node("div", provider, "model-group")); for (const model of models) { const option = button(model.name || model.id || model.modelId, () => { el("model").value = modelKey(model); thinkingOptions(el("thinking"), model); saveDraft();updateComposer();renderModelMenu();void configureModel(); }, "model-option"); option.setAttribute("aria-selected",String(el("model").value === modelKey(model)));option.disabled=el("model").disabled;if (el("model").value === modelKey(model)) option.append(icon("check"));target.append(option); } }
 if (!target.children.length) target.append(node("p", t.noModels, "empty"));
}
function thinkingOptions(select, model, value = "") {
 select.replaceChildren(); const empty = node("option", t.defaultThinking); empty.value = ""; select.append(empty);
 for (const level of model?.thinkingLevels || []) { const option = node("option", t[level] || level); option.value = level; select.append(option); } select.value = value;if (!select.value) select.value = "";if (select.id === "thinking") renderThinkingMenu();
}
function renderThinkingMenu() {
 const target=el("thinking-levels");target.replaceChildren();const model=selectedModel(el("model"));
 for (const level of ["",...(model?.thinkingLevels || [])]) {const b=button(level ? t[level] || level : t.defaultThinking,()=>{el("thinking").value=level;saveDraft();updateComposer();void configureModel();});b.setAttribute("aria-pressed",String(level === el("thinking").value));b.disabled=el("model").disabled || !model?.thinkingLevels?.length;target.append(b);}
}
function selection() { const model = selectedModel(el("model")); return {mode:el("composer-mode").value || state.current?.mode || "agent",...(model ? {providerId:model.providerId,modelId:model.id || model.modelId,...(el("thinking").value ? {thinkingLevel:el("thinking").value} : {})} : {})}; }
function saveDraft() { if (!state.current) return; const draft = state.drafts.get(state.current.id); if (draft.text !== el("message").value) { delete draft.enhancementUndo; draft.editRevision = (draft.editRevision || 0) + 1; } draft.text = el("message").value; draft.model = el("model").value; draft.thinking = el("thinking").value; draft.mode = el("composer-mode").value || state.current.mode || "agent"; draft.permissionModeCeiling = el("composer-permission").value || "ask"; }
function renderAttachments() {
 const target = el("attachment-list"); target.replaceChildren();
 for (const a of state.drafts.get(state.current?.id)?.attachments || []) { const row = node("div", undefined, "attachment-chip"); row.append(node("span", a.name + (a.uploading ? " · " + t.uploading : "")), button(t.remove, () => { const draft = state.drafts.get(state.current.id); draft.attachments = draft.attachments.filter(item => item !== a); renderAttachments(); updateComposer(); })); target.append(row); }
}
function updateComposer() {
 const draft = state.drafts.get(state.current?.id); const controls = !!state.capabilities.controls;
 el("composer").hidden = !controls; el("send").disabled = !controls || state.sending || draft?.attachments.some(a => a.uploading) || !(el("message").value.trim() || draft?.attachments.length);
 el("send").setAttribute("aria-label",state.sending ? t.sending : state.snapshot?.activeTurn ? t.queueSend : t.send);
 el("composer-hint").textContent = state.snapshot?.activeTurn ? t.busy : "";
 el("stop").hidden = !controls || !state.snapshot?.activeTurn; el("interrupt").hidden = el("stop").hidden;
 const model = selectedModel(el("model")); const label = (model?.name || state.current?.modelId || t.defaultModel) + (el("thinking").value ? " · " + (t[el("thinking").value] || el("thinking").value) : ""); el("model-label").textContent = label; el("model-toggle").setAttribute("aria-label",t.model + ": " + label); el("model").disabled = !controls || !!state.snapshot?.activeTurn || state.sending; el("thinking").disabled = el("model").disabled || !model?.thinkingLevels?.length;
 renderThinkingMenu();renderModelMenu();
 updateComposerSettings();
 if (el("message").style) { el("message").style.height = "auto";el("message").style.height = Math.min(132,el("message").scrollHeight) + "px"; }
}
const configuringModels = new Map();
async function configureModel() {
 const config = selection(); const sessionId = state.current?.id; const generation = state.generation;if (!sessionId || state.snapshot?.activeTurn) return;
 const previous = configuringModels.get(sessionId) || Promise.resolve();
 const pending = previous.catch(() => {}).then(async () => {if (generation !== state.generation || sessionId !== state.current?.id) return;const result = await action("session/configure",{sessionId,...config});if (generation !== state.generation || sessionId !== state.current?.id) return;state.configs.set(sessionId,JSON.stringify(config));state.current = result.session || state.current;updateComposer();});
 configuringModels.set(sessionId,pending);try {await pending;}catch(error) {if (generation === state.generation) showError(error.message || t.actionFailed);}finally {if (configuringModels.get(sessionId) === pending) configuringModels.delete(sessionId);}
}
async function sendMessage() {
 if (!state.current || !state.capabilities.controls || state.sending) return;
 saveDraft(); const sessionId = state.current.id; const generation = state.generation; const draft = state.drafts.get(sessionId); const text = draft.text; const attachments = draft.attachments.filter(a => a.id).map(a => a.id); const config = selection();
 if ((!text.trim() && !attachments.length) || draft.attachments.some(a => a.uploading)) return;
 const permissionModeCeiling = draft.permissionModeCeiling || "ask";
 const fingerprint = JSON.stringify({text,attachments,config,permissionModeCeiling});
 if (draft.pending?.fingerprint !== fingerprint) draft.pending = {fingerprint,key:crypto.randomUUID(),messageId:crypto.randomUUID(),requestId:crypto.randomUUID()};
 const pending = draft.pending; state.sending = true; showError(""); updateComposer();
 try {
  await configuringModels.get(sessionId);if (generation !== state.generation || state.current?.id !== sessionId) return;
  if (!state.snapshot?.activeTurn && state.configs.get(sessionId) !== JSON.stringify(config)) { const configured=await action("session/configure", {sessionId,...config}); if (generation !== state.generation) return; state.configs.set(sessionId, JSON.stringify(config));state.current=configured.session || state.current; }
  const result = await action("turn/start", {sessionId,permissionModeCeiling,admission:"queue",idempotencyKey:pending.key,input:{text,messageId:pending.messageId,...(attachments.length ? {attachments} : {})},context:{requestId:pending.requestId,idempotencyKey:pending.key}});
  if (generation !== state.generation || state.current?.id !== sessionId) return;
  acceptTurn(result.turn);
  if (el("message").value === text && draft.pending === pending && JSON.stringify(draft.attachments.filter(a => a.id).map(a => a.id)) === JSON.stringify(attachments)) { draft.text = ""; draft.attachments = []; draft.pending = null; delete draft.enhancementUndo; el("message").value = ""; renderAttachments(); }
  if (result.turn?.status === "queued") el("composer-hint").textContent = t.queuedAccepted;
  await snapshot(generation);
 } catch (error) { if (generation === state.generation) showError((error.message || t.actionFailed) + " " + t.draftRetained); }
 finally { if (generation === state.generation) { state.sending = false; updateComposer(); } }
}
function retryLastMessage() { const last = [...messages()].reverse().find(m => m.role === "user"); if (!last) return; el("message").value = last.command || last.content; saveDraft(); updateComposer(); el("message").focus(); }
async function uploadFiles(files) {
 const generation = state.generation; const sessionId = state.current?.id; if (!sessionId || !state.capabilities.controls) return; const draft = state.drafts.get(sessionId);
 for (const file of files) {
  if (generation !== state.generation) break; const pending = {name:file.name,uploading:true}; draft.attachments.push(pending); renderAttachments(); updateComposer();
  try { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (let n = 0; n < bytes.length; n += 8192) binary += String.fromCharCode(...bytes.subarray(n, n + 8192)); const result = await api("/v1/sessions/" + encodeURIComponent(sessionId) + "/attachments", {method:"POST",body:JSON.stringify({name:file.name,mimeType:file.type || "application/octet-stream",data:btoa(binary)})}); Object.assign(pending, result, {uploading:false}); }
  catch (error) { draft.attachments = draft.attachments.filter(a => a !== pending); if (generation === state.generation) showError(t.uploadError + " " + (error.message || "")); }
  finally { if (generation === state.generation) { renderAttachments(); updateComposer(); } }
 }
}
function dialog(kind) {
 const modal = el("task-dialog"); const target = el("dialog-content"); target.replaceChildren(); const generation = state.generation; const session = state.current; const title = t[kind]; target.append(node("h2", title));
 const form = node("form"); const fields = {};
 const addField = (id, label, control) => { const wrapper = node("label", label); control.setAttribute("aria-label", label); wrapper.append(control); form.append(wrapper); fields[id] = control; return control; };
 if (kind === "newTask" || kind === "rename" || kind === "fork") { const input = node("input"); input.type = "text"; input.maxLength = 80; input.value = kind === "rename" ? session.title : ""; input.required = kind === "rename"; addField("title", t.title, input); }
 if (kind === "newTask") { const project = node("select"); const empty = node("option", t.defaultProject); empty.value = ""; project.append(empty); for (const p of state.projects.filter(p => !p.archived)) { const o = node("option", p.label); o.value = p.id; project.append(o); } addField("project",t.project,project); const model = addField("model",t.model,node("select")); modelOptions(model); const thinking = addField("thinking",t.thinking,node("select")); thinkingOptions(thinking); model.addEventListener("change", () => thinkingOptions(thinking,selectedModel(model))); const mode = addField("mode",t.sessionMode,node("select")); for (const value of ["agent","plan","goal"]) { const o = node("option", t[value]); o.value = value; mode.append(o); } }
 else if (kind === "delete") form.append(node("p",t.deleteHelp,"hint"));
 const error = node("p", "", "error"); error.setAttribute("role","alert"); const submit = node("button", kind === "newTask" ? t.create : kind === "rename" ? t.save : t.confirm, kind === "delete" ? "danger" : "primary"); submit.type = "submit";
 form.addEventListener("submit", async event => {
  event.preventDefault(); submit.disabled = true; error.textContent = "";
  try { let result;
   if (kind === "newTask") { const model = selectedModel(fields.model); result = await action("session/create", {title:fields.title.value.trim(),mode:fields.mode.value,permissionMode:"ask",...(fields.project.value ? {projectId:fields.project.value} : {}),...(model ? {providerId:model.providerId,modelId:model.id || model.modelId,...(fields.thinking.value ? {thinkingLevel:fields.thinking.value} : {})} : {})}); }
   else result = await action("session/" + kind, {sessionId:session.id,...(fields.title?.value.trim() ? {title:fields.title.value.trim()} : {})});
   if (generation !== state.generation) return; modal.close(); if (result.session && ["newTask","fork"].includes(kind)) await open(result.session); else if (kind === "delete") await list(); else if (kind === "rename") { state.current.title = fields.title.value.trim(); el("conversation-title").textContent = state.current.title; } else { el("composer-hint").textContent = t.compactAccepted; await snapshot(generation); }
  } catch (err) { if (generation === state.generation) error.textContent = err.message || t.actionFailed; } finally { submit.disabled = false; }
 }); form.append(error,submit,button(t.cancel, () => modal.close())); target.append(form); modal.showModal(); fields.title?.focus();
}
async function loadChanges(more = false) {
 const sessionId = state.current?.id; const generation = state.generation; if (!sessionId) return; el("changes-error").textContent = "";
 if (!more) void loadReviews();
 try { const offset = more ? state.changes?.nextOffset : 0; if (more && offset === undefined) return; const [result,preview] = await Promise.all([api("/v1/sessions/" + encodeURIComponent(sessionId) + "/diff/list", {method:"POST",body:JSON.stringify({offset,limit:100})}), more ? Promise.resolve(state.preview) : action("workspace/diff", {sessionId})]); if (generation !== state.generation) return; state.preview = preview; state.changes = {...result,files:more ? [...state.changes.files,...result.files] : result.files}; renderDiffFiles(state.changes,preview); }
 catch (error) { if (generation === state.generation) el("changes-error").textContent = error.message || t.actionFailed; }
}
async function loadReviews(more = false) {
 const sessionId = state.current?.id; const generation = state.generation;if (!sessionId || !state.capabilities.recordedReviews) return;
 try {const result = await api("/v1/sessions/" + encodeURIComponent(sessionId) + "/review/list",{method:"POST",body:JSON.stringify(more && state.reviews?.nextBeforeItemId ? {beforeItemId:state.reviews.nextBeforeItemId} : {})});if (generation !== state.generation) return;const entries = new Map([...(more ? state.reviews?.entries || [] : []),...result.entries].map(entry => [entry.change.snapshotId,entry]));state.reviews = {...result,entries:[...entries.values()]};renderReviews();}
 catch(error) {if (generation === state.generation) el("reviews-error").textContent = error.message || t.actionFailed;}
}
async function fullPatch(path) {
 const sessionId = state.current?.id; const generation = state.generation; if (!sessionId || !isWorkspacePath(path)) return;
 try { const patch = await api("/v1/sessions/" + encodeURIComponent(sessionId) + "/diff/patch", {method:"POST",body:JSON.stringify({path}),text:true}); if (generation !== state.generation) return; const target = el("file-content"); target.replaceChildren(node("h3",path),rawActions(patch,path.split("/").pop() + ".patch"),patchView(patch)); el("file-content").scrollIntoView({block:"nearest"}); }
 catch (error) { if (generation === state.generation) el("changes-error").textContent = error.message || t.actionFailed; }
}
async function browseWorkspace(path = "") {
 const sessionId = state.current?.id; const generation = state.generation; if (!sessionId || (path && !isWorkspacePath(path))) return;
 try { const result = await action("workspace/list", {sessionId,path}); if (generation !== state.generation) return; state.path = path; el("workspace-path").value = path; const target = el("workspace-files"); target.replaceChildren(); if (path) target.append(button(t.parent, () => browseWorkspace(path.split("/").slice(0,-1).join("/")))); for (const entry of result.entries || []) { const entryPath = [path,entry.name].filter(Boolean).join("/"); target.append(button(entry.name + (entry.kind === "dir" ? "/" : ""), () => entry.kind === "dir" ? browseWorkspace(entryPath) : viewWorkspaceFile(entryPath),"file-row")); } if (!result.entries?.length) target.append(node("p",t.noFiles,"hint")); }
 catch (error) { if (generation === state.generation) el("changes-error").textContent = error.message || t.actionFailed; }
}
async function viewWorkspaceFile(path) {
 const sessionId = state.current?.id; const generation = state.generation; if (!sessionId || !isWorkspacePath(path)) return;
 try { const result = await action("workspace/read", {sessionId,path}); if (generation !== state.generation) return; taskTab("changes"); renderFile(result,path); el("file-content").scrollIntoView({block:"nearest"}); }
 catch (error) { if (generation === state.generation) showError(error.message || t.actionFailed); }
}
async function viewAttachment(messageId, attachment) {
 const sessionId = state.current?.id; const generation = state.generation; if (!sessionId) return;
 try {
  const result = await api("/v1/sessions/" + encodeURIComponent(sessionId) + "/attachment/read", {method:"POST",body:JSON.stringify({messageId,ref:attachment.ref}),blob:true});
  if (generation !== state.generation) return;
  taskTab("changes"); const target = el("file-content"); target.replaceChildren(node("h3",attachment.name || t.attachmentRef));
  target.append(button(t.download, () => download(attachment.name || "attachment",result.blob,result.blob.type)));
  if (/^image\/(png|jpeg|webp|gif)$/.test(result.mime || "")) { const img = node("img"); const url = URL.createObjectURL(result.blob); img.onload = img.onerror = () => URL.revokeObjectURL(url); img.src = url; img.alt = attachment.name || t.attachmentRef; target.append(img); }
  else if (/^(text\/|application\/(json|xml))/.test(attachment.mimeType || "") && result.blob.size <= 2 * 1024 * 1024) target.append(node("pre",await result.blob.text(),"raw-text"));
  el("file-content").scrollIntoView({block:"nearest"});
 } catch (error) { if (generation === state.generation) showError(error.message || t.actionFailed); }
}
function taskTab(name) { el("task-panel").hidden = name !== "task"; el("changes-panel").hidden = name !== "changes"; for (const id of ["task","changes"]) { el(id + "-tab").setAttribute("aria-selected",String(id === name)); } }
`;
