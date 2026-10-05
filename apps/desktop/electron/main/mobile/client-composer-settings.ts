import { calculateContextUsage, contextOccupancyTokens, latestMessageUsage, usageTokenTotal, DEFAULT_CONTEXT_WINDOW } from "../../../src/lib/context-usage";

/** Reuse the desktop's request-occupancy math, rather than summing turn usage. */
export const mobileComposerSettingsScript = `
const DEFAULT_CONTEXT_WINDOW = ${DEFAULT_CONTEXT_WINDOW};
function positiveTokenCount(value) {return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;}
const usageTokenTotal = ${usageTokenTotal.toString()};
const contextOccupancyTokens = ${contextOccupancyTokens.toString()};
const latestMessageUsage = ${latestMessageUsage.toString()};
const calculateContextUsage = ${calculateContextUsage.toString()};
` + String.raw`
const permissionModes = ["ask","accept-edits","auto"];
const enhancingDrafts = new Map();
function permissionOptions() {
 const stored = permissionModes.indexOf(state.current?.permissionMode);
 const remote = permissionModes.indexOf(state.capabilities.remoteMaxPermissionMode || "ask");
 return permissionModes.slice(0,Math.min(stored < 0 ? 0 : stored,remote < 0 ? 0 : remote) + 1);
}
function restoreComposerSettings() {
 const draft = state.drafts.get(state.current?.id); if (!draft) return;
 draft.mode = state.current.mode || "agent";
 draft.permissionModeCeiling ||= "ask";
 el("composer-mode").value = draft.mode;
 updateComposerSettings();
}
function updateComposerSettings() {
 const draft = state.drafts.get(state.current?.id); const controls = !!state.capabilities.controls;
 const modes = el("composer-mode"); modes.disabled = !controls || !!state.snapshot?.activeTurn || state.sending;
 if (draft && modes.value !== draft.mode) modes.value = draft.mode || state.current.mode || "agent";
 const permission = el("composer-permission"); const allowed = permissionOptions(); const identity = allowed.join(",");
 if (permission.dataset.allowed !== identity) { permission.replaceChildren(); for (const value of allowed) {const option=node("option",t[value === "accept-edits" ? "acceptEdits" : value]);option.value=value;permission.append(option);}permission.dataset.allowed=identity; }
 if (draft && !allowed.includes(draft.permissionModeCeiling)) draft.permissionModeCeiling = "ask";
 permission.value = draft?.permissionModeCeiling || "ask";permission.disabled = !controls || state.sending;
 const enhancing = enhancingDrafts.has(state.current?.id);
 const enhance = el("enhance-prompt");enhance.hidden = !state.capabilities.promptEnhancement;
 enhance.disabled = !controls || enhancing || state.sending || !(selectedModel(el("model")) || state.current?.modelId) || !el("message").value.trim() || el("message").value.trim().startsWith("/");
 enhance.setAttribute("aria-busy",String(enhancing));enhance.setAttribute("aria-label",enhancing ? t.enhancingPrompt : t.enhancePrompt);
 el("enhancement-undo").hidden = draft?.enhancementUndo === undefined;el("enhancement-undo").disabled = state.sending || enhancing;
 const output = el("context-remaining"); const usage = latestMessageUsage(messages());
 if (!usage) { output.textContent = "—";output.title = t.noContextUsage;output.setAttribute("aria-label",t.contextRemaining + ": " + t.noContextUsage); }
 else { const model = state.models.find(m => m.providerId === state.current?.providerId && (m.id || m.modelId) === state.current?.modelId) || selectedModel(el("model"));const window = model?.contextWindow || DEFAULT_CONTEXT_WINDOW;const context = calculateContextUsage(usage,window);output.textContent = context.remainingPercent + "%";output.title = t.contextRemaining + ": " + context.remainingTokens.toLocaleString() + " / " + window.toLocaleString() + " " + t.contextTokens;output.setAttribute("aria-label",output.title);output.dataset.low = String(context.remainingPercent <= 20); }
}
async function enhancePrompt() {
 const sessionId=state.current?.id;const draft=state.drafts.get(sessionId);const text=el("message").value;const generation=state.generation;const revision=draft?.editRevision || 0;
 if (!sessionId || !draft || el("enhance-prompt").disabled) return;
 const request={};enhancingDrafts.set(sessionId,request);delete draft.enhancementUndo;showError("");updateComposerSettings();
 try {
  const model=selection();const result=await api("/v1/action",{method:"POST",timeoutMs:65000,body:JSON.stringify({method:"prompt/enhance",params:{sessionId,draft:text,...(model.providerId ? {providerId:model.providerId,modelId:model.modelId} : {}),...(model.thinkingLevel ? {thinkingLevel:model.thinkingLevel === "omit" ? "off" : model.thinkingLevel} : {})}})});
  if (generation !== state.generation || state.current?.id !== sessionId || enhancingDrafts.get(sessionId) !== request || (draft.editRevision || 0) !== revision || el("message").value !== text) return;
  const enhanced=result.enhancedDraft?.trim();if (!enhanced) throw new Error(t.actionFailed);
  el("message").value=enhanced;saveDraft();draft.enhancementUndo=text;updateComposer();el("message").focus();el("message").setSelectionRange?.(enhanced.length,enhanced.length);
 } catch(error) {if (generation === state.generation && state.current?.id === sessionId && (draft.editRevision || 0) === revision && el("message").value === text) showError(error.message || t.actionFailed);}
 finally {if (enhancingDrafts.get(sessionId) === request) enhancingDrafts.delete(sessionId);if (generation === state.generation && state.current?.id === sessionId) updateComposerSettings();}
}
function undoPromptEnhancement() {
 const draft=state.drafts.get(state.current?.id);if (draft?.enhancementUndo === undefined) return;
 const text=draft.enhancementUndo;delete draft.enhancementUndo;el("message").value=text;saveDraft();updateComposer();el("message").focus();el("message").setSelectionRange?.(text.length,text.length);
}
function initComposerSettings() {
 el("composer-mode").addEventListener("change",() => {saveDraft();updateComposer();void configureModel();});
 el("composer-permission").addEventListener("change",() => {saveDraft();updateComposer();});
 el("enhance-prompt").addEventListener("click",() => void enhancePrompt());
 el("enhancement-undo").addEventListener("click",undoPromptEnhancement);
}
`;
