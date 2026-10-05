/** Safe DOM rendering for messages and read-only workspace evidence. */
export const mobileRenderScript = String.raw`
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (className) n.className = className; return n; }
function icon(name, className = "glyph") { const n = node("span", undefined, className); n.innerHTML = iconMarkup[name]; n.setAttribute("aria-hidden","true"); return n; }
function button(label, run, className = "quiet") { const n = node("button", label, className); n.type = "button"; n.addEventListener("click", run); return n; }
function safeLink(value) { try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; } }
function inline(parent, text) {
 const pattern = /\x60([^\x60]+)\x60|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*/g;
 let start = 0; let match;
 while ((match = pattern.exec(text))) {
  parent.append(document.createTextNode(text.slice(start, match.index)));
  if (match[1] !== undefined) parent.append(node("code", match[1]));
  else if (match[2] !== undefined) { const href = safeLink(match[3]); if (href) { const a = node("a", match[2]); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; parent.append(a); } else parent.append(document.createTextNode(match[0])); }
  else parent.append(node(match[4] || match[5] ? "strong" : "em", match[4] || match[5] || match[6]));
  start = pattern.lastIndex;
 }
 parent.append(document.createTextNode(text.slice(start)));
}
function markdown(text) {
 const root = node("div", undefined, "markdown"); const lines = String(text || "").replace(/\r\n/g, "\n").split("\n"); let i = 0;
 const cells = line => line.trim().replace(/^\||\|$/g, "").split("|").map(s => s.trim());
 while (i < lines.length) {
  const line = lines[i];
  if (!line.trim()) { i++; continue; }
  const fence = line.match(/^\s*(\x60{3,}|~{3,})(.*)$/);
  if (fence) { const code = []; i++; while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]); if (i < lines.length) i++; const pre = node("pre", undefined, "code-block"); pre.append(node("code", code.join("\n"))); if (fence[2].trim()) pre.dataset.language = fence[2].trim(); root.append(pre); continue; }
  if (i + 1 < lines.length && line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
   const wrap = node("div", undefined, "table-scroll"); const table = node("table"); const head = node("tr"); for (const value of cells(line)) { const cell = node("th"); inline(cell, value); head.append(cell); } table.append(head); i += 2;
   while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { const row = node("tr"); for (const value of cells(lines[i++])) { const cell = node("td"); inline(cell, value); row.append(cell); } table.append(row); } wrap.append(table); root.append(wrap); continue;
  }
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) { const h = node("h" + heading[1].length); inline(h, heading[2]); root.append(h); i++; continue; }
  if (/^\s*([-*+] |\d+\. )/.test(line)) {
   const ordered = /^\s*\d+\./.test(line); const list = node(ordered ? "ol" : "ul");
   while (i < lines.length && (ordered ? /^\s*\d+\. /.test(lines[i]) : /^\s*[-*+] /.test(lines[i]))) { const li = node("li"); inline(li, lines[i++].replace(/^\s*(?:[-*+]|\d+\.) /, "")); list.append(li); } root.append(list); continue;
  }
  if (/^>\s?/.test(line)) { const q = node("blockquote"); inline(q, line.replace(/^>\s?/, "")); root.append(q); i++; continue; }
  const paragraph = node("p"); inline(paragraph, line); root.append(paragraph); i++;
 }
 return root;
}
function raw(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""; }
function download(name, text, type = "text/plain") { const url = URL.createObjectURL(new Blob([text], { type })); const a = node("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function rawActions(text, filename) {
 const row = node("div", undefined, "actions"); const copy = button(t.copy, async () => { try { await navigator.clipboard.writeText(text); copy.textContent = t.copied; } catch { showError(t.actionFailed); } }); row.append(copy, button(t.download, () => download(filename, text))); return row;
}
function disclosure(label, key, content, opened) { const d = node("details", undefined, "disclosure"); d.dataset.item = key; d.open = opened?.has(key) || false; d.append(node("summary", label), content); return d; }
function normalizeItem(item) {
 const c = item.content;
 if (c && typeof c === "object" && c.role) return { status:item.status === "streaming" ? "streaming" : c.status,...c, id: c.id || item.id };
 if (item.role) return item;
 if (item.itemType === "tool") return { id:item.id, role:"tool", content:"", createdAt:item.createdAt, toolCallId:c?.toolCallId || item.id, toolName:c?.toolName, toolArgs:c?.args, toolResult:c?.result ?? c?.partialResult, toolStatus:item.status === "streaming" ? "running" : c?.isError ? "error" : "success", isError:c?.isError, parentToolCallId:item.parentToolCallId, agentName:item.agentName };
 return { id:item.id, role:"system", content:raw(c), createdAt:item.createdAt, status:item.status };
}
function messages() {
 const map = new Map();
 for (const item of [...state.items, ...(state.snapshot?.items || []), ...(state.snapshot?.activeItems || [])]) { const message = normalizeItem(item); map.set(message.id, { ...(map.get(message.id) || {}), ...message }); }
 for (const [id, entry] of state.live) map.set(id, { ...(map.get(id) || {}), ...entry.message });
 return [...map.values()].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}
const transcriptRows = new Map();
function clearTranscript() { transcriptRows.clear(); el("transcript").replaceChildren(); }
function sameMessage(a,b) {const keys=Object.keys(a);return keys.length===Object.keys(b).length && keys.every(key=>a[key]===b[key]);}
function createMessageRow(m) {
 const tool=m.role==="tool";const row=node(tool?"details":"article",undefined,tool?"tool-message":"message "+m.role);row.dataset.item=m.id;
 const entry={row,message:m};let content;let thinking;let toolBody;let toolSummary;let toolStatus;
 if(tool) {
  const summary=node("summary");const action=getToolAction(m.toolName);toolSummary=node("span",undefined,"tool-summary");toolStatus=node("span",undefined,"tool-status");
  summary.append(icon(action==="run"?"terminal":action==="delegate"?"bot":["write","edit"].includes(action)?"pencil":action==="read"?"file":action==="list"?"folder":action==="search"?"search":"wrench","tool-icon"),node("span",t["action_"+action]||getToolDisplayName(m.toolName)||t.tool,"tool-name"),toolSummary,toolStatus,icon("chevronRight","tool-caret"));
  toolBody=node("div",undefined,"tool-body");row.append(summary,toolBody);
 } else {row.append(node("div",t[m.role]||t.assistant,"message-role"));content=node("div",undefined,"markdown message-content");row.append(content);}
 const metadata=node("small",undefined,"meta");row.append(metadata);
 const trace=node("div");const detail=disclosure(t.rawJson,m.id+":raw",trace);detail.className+=" raw-disclosure";detail.children[0].replaceChildren(icon("more"),node("span",t.rawJson,"sr-only"));detail.children[0].setAttribute("aria-label",t.rawJson);row.append(detail);
 let renderedRaw;let renderedTool;let renderedThinking;
 const renderRaw=()=>{if(!detail.open||renderedRaw===entry.message)return;renderedRaw=entry.message;const json=raw(entry.message);trace.replaceChildren(rawActions(json,"pi-message-"+m.id+".json"),node("pre",json,"raw-text"));};
 const renderTool=()=>{if(!tool||!row.open||renderedTool===entry.message)return;renderedTool=entry.message;const value=entry.message;toolBody.replaceChildren();
  if(value.toolName||value.toolCallId)toolBody.append(node("p",[value.toolName,value.toolCallId,value.toolDurationMs!==undefined?value.toolDurationMs+" ms":""].filter(Boolean).join(" · "),"meta"));
  if(value.agentName||value.parentToolCallId)toolBody.append(node("p",[value.agentName,value.parentToolCallId].filter(Boolean).join(" · "),"meta"));
  if(getToolAction(value.toolName)==="run"){const command=getToolSummaryValue(value.toolName,value.toolArgs);if(command)toolBody.append(node("pre",command,"raw-text"),rawActions(command,"pi-command.txt"));}
  for(const[label,data]of[[t.arguments,value.toolArgs],[t.result,value.toolResult]])if(data!==undefined)toolBody.append(node("h3",label),node("pre",raw(data),"raw-text"));
  if(value.content)toolBody.append(markdown(value.content));
 };
 const renderThinking=()=>{if(!thinking?.open||renderedThinking===entry.message.thinking)return;renderedThinking=entry.message.thinking;thinking.children[1].replaceChildren(markdown(entry.message.thinking));};
 detail.addEventListener("toggle",renderRaw);if(tool)row.addEventListener("toggle",renderTool);
 let attachments;let previousAttachments;let errorBody;let previousError;
 entry.update=value=>{
  const old=entry.message;entry.message=value;
  if(tool){row.dataset.status=value.toolStatus;toolStatus.textContent=t[value.toolStatus==="running"?"toolRunning":value.toolStatus]||value.toolStatus||"";if(old.toolArgs!==value.toolArgs||!toolSummary.textContent)toolSummary.textContent=getToolSummary(value.toolName,value.toolArgs);renderTool();}
  else {
   if(value.content!==old.content||value.status!==old.status||!content.children.length){if(value.status==="streaming")content.replaceChildren(node("p",value.content||""));else content.replaceChildren(markdown(value.content));}
   if(value.thinking&&!thinking){thinking=disclosure(t.thinkingDetails,m.id+":thinking",node("div"));thinking.className+=" thinking-disclosure";thinking.children[0].replaceChildren(icon("sparkles"),node("span",t.thinkingDetails),icon("chevronRight"));thinking.addEventListener("toggle",renderThinking);row.insertBefore(thinking,content);}
   if(thinking){thinking.hidden=!value.thinking;renderThinking();}
  }
  metadata.textContent=value.status?t[value.status]||value.status:"";
  if(value.attachments!==previousAttachments){attachments?.remove();previousAttachments=value.attachments;
   if(value.attachments?.length){attachments=node("div",undefined,"attachment-refs");for(const a of value.attachments){const chip=node("div",undefined,"attachment-ref");chip.append(node("span",a.name||t.attachmentRef),node("small",a.ref||a.id||""));if(state.capabilities.attachmentRead&&a.ref)chip.append(button(t.viewFile,()=>viewAttachment(value.id,a)));else if(isWorkspacePath(a.ref))chip.append(button(t.viewFile,()=>viewWorkspaceFile(a.ref)));else chip.append(node("small",t.unsafeRef));attachments.append(chip);}row.insertBefore(attachments,metadata);}
  }
  if(value.error!==previousError){errorBody?.remove();previousError=value.error;if(value.error){errorBody=node("div");errorBody.append(disclosure(t.errorDetails,m.id+":error",node("pre",raw(value.error),"raw-text")));if(value.error.retriable&&state.capabilities.controls)errorBody.append(button(t.retryTurn,retryLastMessage));row.insertBefore(errorBody,detail);}}
  renderRaw();
 };
 entry.update(m);return entry;
}
function renderTranscript() {
 const transcript=el("transcript");const scroll=el("transcript-scroll");const stick=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<100;const oldTop=scroll.scrollTop;const all=messages();const ids=new Set(all.map(m=>m.id));
 for(const[id,entry]of transcriptRows)if(!ids.has(id)){entry.row.remove();transcriptRows.delete(id);}
 if(all.length&&transcript.children[0]?.className==="empty")transcript.replaceChildren();
 all.forEach((m,index)=>{let entry=transcriptRows.get(m.id);if(!entry){entry=createMessageRow(m);transcriptRows.set(m.id,entry);}else if(!sameMessage(entry.message,m))entry.update(m);if(transcript.children[index]!==entry.row)transcript.insertBefore(entry.row,transcript.children[index]||null);});
 if(!all.length){transcript.replaceChildren(node("p",t.noMessages,"empty"));}el("more").hidden=!state.hasMore;scroll.scrollTop=stick?scroll.scrollHeight:oldTop;
}
let transcriptFrame=null;
function scheduleTranscript() {if(transcriptFrame!==null)return;const generation=state.generation;transcriptFrame=requestAnimationFrame(()=>{transcriptFrame=null;if(generation===state.generation)renderTranscript();});}
function cancelTranscript() {if(transcriptFrame!==null)cancelAnimationFrame(transcriptFrame);transcriptFrame=null;}
function applyEvent(envelope) {
 if (envelope.sequence !== undefined && state.cursor?.epoch === envelope.epoch && envelope.sequence <= state.cursor.sequence) return false;
 const event = envelope.payload?.event; state.version++; state.trace.push(envelope);
 if (envelope.sequence !== undefined) state.cursor = { epoch:envelope.epoch, sequence:envelope.sequence };
 if (!event) return false;
 const save = message => state.live.set(message.id, { message, version:state.version });
 const previous = id => state.live.get(id)?.message || messages().find(m => m.id === id);
 if (["message_start","message_end","message_update","user_message_persisted"].includes(event.type)) {
  if (event.replacesMessageId) { state.live.delete(event.replacesMessageId); state.items = state.items.filter(i => i.id !== event.replacesMessageId); }
  if (event.optimisticMessageId) { state.live.delete(event.optimisticMessageId); state.items = state.items.filter(i => i.id !== event.optimisticMessageId); }
  if (event.precedingAssistant) save(event.precedingAssistant);
  const message=event.type === "message_update" ? applyMessageUpdate(previous(event.message.id), event) : event.message;save({...message,status:event.type === "message_end" ? (message.status || "complete") : event.type === "user_message_persisted" ? message.status : "streaming"}); return true;
 }
 if (["tool_start","tool_update","tool_end"].includes(event.type)) {
  const old = previous(event.toolCallId) || { id:event.toolCallId, role:"tool", content:"", createdAt:envelope.occurredAt, toolCallId:event.toolCallId };
  save({ ...old, ...(event.type === "tool_start" ? {toolName:event.toolName,toolArgs:event.args,toolStatus:"running"} : event.type === "tool_update" ? {toolResult:event.partialResult} : {toolResult:event.result,toolStatus:event.isError ? "error" : "success",isError:event.isError,toolDurationMs:Math.max(0,Date.parse(envelope.occurredAt)-Date.parse(old.createdAt)),toolCompletedAt:envelope.occurredAt,...(event.toolUsage !== undefined ? {toolUsage:event.toolUsage} : {})}), ...(event.agentName ? {agentName:event.agentName} : {}), ...(event.parentToolCallId ? {parentToolCallId:event.parentToolCallId} : {}), ...(envelope.agentName ? {agentName:envelope.agentName} : {}), ...(envelope.parentToolCallId ? {parentToolCallId:envelope.parentToolCallId} : {}) }); return true;
 }
 if (event.type === "error") showError(event.error.message); return false;
}
function isWorkspacePath(path) { return typeof path === "string" && !!path && !/^(?:[a-z]:|[\\/]|[a-z]+:)/i.test(path) && !path.split(/[\\/]/).includes(".."); }
function patchView(text) {
 const pre = node("pre",undefined,"patch"); let oldLine = 0;let newLine = 0;let hunk = false;
 for (const line of String(text).split("\n")) { const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if (header) {oldLine = Number(header[1]);newLine = Number(header[2]);hunk = true;} const kind = header ? "hunk" : hunk && line.startsWith("+") ? "add" : hunk && line.startsWith("-") ? "del" : "context"; const numbered = hunk && !header && /^[ +\-]/.test(line); const row = node("div",undefined,"patch-line diff-" + kind); row.append(node("span",numbered && kind !== "add" ? oldLine++ : "","line-number"),node("span",numbered && kind !== "del" ? newLine++ : "","line-number"),node("span",line));pre.append(row); }
 return pre;
}
function renderDiffFiles(result, preview) {
 const target = el("diff-files"); target.replaceChildren();
 el("changes-summary").textContent = result.repo ? String(result.total ?? result.files?.length ?? 0) + " " + t.files : "";
 if (!result.repo) target.append(node("p", t.notRepo, "hint")); else if (result.clean) target.append(node("p", t.noChanges, "empty"));
 if (preview?.truncated) target.append(node("p", t.truncated + " " + t.limitPreview, "hint"));
 for (const file of result.files || []) {
  const details = node("details",undefined,"diff-file"); const summary = node("summary"); const kind = node("span",t[file.status] || file.status,"diff-kind");kind.dataset.status = file.status;summary.append(icon("chevronRight"),node("span",file.oldPath ? file.oldPath + " → " + file.path : file.path,"diff-path"),kind);details.append(summary);
  const bounded = preview?.files?.find(f => f.path === file.path); const actions = node("div", undefined, "actions"); actions.append(button(t.fullPatch, () => fullPatch(file.path)), button(t.readFile, () => viewWorkspaceFile(file.path))); details.append(actions);
  if (bounded) { if (bounded.binary) details.append(node("p",t.binary,"hint"));if (bounded.tooLarge) details.append(node("p",t.tooLarge + " " + t.limitPreview,"hint"));for (const h of bounded.hunks || []) details.append(patchView(h.header + "\n" + h.lines.map(l => (l.type === "add" ? "+" : l.type === "del" ? "-" : " ") + l.text).join("\n"))); }
  target.append(details);
 }
 el("diff-more").hidden = result.nextOffset === undefined;
}
function renderReviews() {
 const entries=state.reviews?.entries || [];const stats=el("review-summary");stats.replaceChildren(node("span",entries.length + " " + t.files),node("span","+" + entries.reduce((n,e)=>n+e.change.additions,0),"diff-addition"),node("span","−" + entries.reduce((n,e)=>n+e.change.deletions,0),"diff-deletion"));
 const target = el("review-records");target.replaceChildren();el("reviews-error").textContent = "";
 for (const {change} of state.reviews?.entries || []) {const details = node("details",undefined,"diff-file");const summary = node("summary");summary.append(icon("chevronRight"),node("span",change.path,"diff-path"),node("span","+" + change.additions,"diff-addition"),node("span","−" + change.deletions,"diff-deletion"));details.append(summary);if (change.state === "rolledBack") details.append(node("p",t.rolledBack,"hint"));if (change.binary) details.append(node("p",t.binary,"hint"));if (change.truncated) details.append(node("p",t.reviewTruncated,"hint"));for (const hunk of change.hunks || []) details.append(patchView(hunk.header + "\n" + hunk.lines.map(line => (line.type === "add" ? "+" : line.type === "del" ? "-" : " ") + line.text).join("\n"))); const json = raw(change);details.append(rawActions(json,"pi-review-" + change.snapshotId + ".json"));target.append(details);}
 if (!state.reviews?.entries.length) target.append(node("p",t.noRecordedChanges,"hint"));el("review-more").hidden = !state.reviews?.hasMore;
}
function renderFile(result, path) {
 const target = el("file-content"); target.replaceChildren(node("h3", path));
 if (result.kind === "text") target.append(rawActions(result.content || "", path.split("/").pop()), node("pre", result.content || "", "raw-text"));
 else if (result.kind === "image" && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(result.dataUrl || "")) { const img = node("img"); img.src = result.dataUrl; img.alt = path; target.append(img); }
 else target.append(node("p", result.kind === "tooLarge" ? t.tooLarge : t.binary, "hint"));
 if (result.truncated) target.append(node("p", t.truncated, "hint"));
}
`;
