/** Host-issued approvals and questions retain their own interaction lifecycle. */
import { currentValues, draftAnswers, emptyDrafts } from "../../../src/lib/asktool-answer-state";

export const mobileRequestsScript = `const currentValues = ${currentValues.toString()};\nconst draftAnswers = ${draftAnswers.toString()};\nconst emptyDrafts = ${emptyDrafts.toString()};\n` + String.raw`
const requestCards=new Map();let queueFingerprint="";
function clearRequests(){requestCards.clear();queueFingerprint="";el("requests").replaceChildren();el("queue").replaceChildren();}
function observeRequests(envelope){
 const snapshot=state.snapshot;if(!snapshot)return;const payload=envelope.payload;
 if(envelope.kind==="approval.requested")snapshot.pendingApprovals=[...(snapshot.pendingApprovals||[]).filter(r=>r.id!==payload.id),payload];
 else if(envelope.kind==="input.requested")snapshot.pendingInputs=[...(snapshot.pendingInputs||[]).filter(r=>r.id!==payload.id),payload];
 else if(envelope.kind==="approval.resolved")snapshot.pendingApprovals=(snapshot.pendingApprovals||[]).filter(r=>r.id!==payload.approvalId);
 else if(envelope.kind==="input.resolved")snapshot.pendingInputs=(snapshot.pendingInputs||[]).filter(r=>r.id!==payload.inputId);
 else return;
 renderRequests();updateActivity();
}
async function respondRequest(card,kind,request,params){
 if(card.dataset.pending==="true")return;const generation=state.generation;const operation=crypto.randomUUID();card.dataset.operation=operation;card.dataset.pending="true";
 const buttons=[...card.querySelectorAll("button")];buttons.forEach(b=>b.disabled=true);const error=card.querySelectorAll("p").find(n=>n.className==="error");error.textContent="";
 try{
  const result=await action(kind==="approval"?"approval/respond":"input/respond",params);
  if(generation!==state.generation)return;
  const key=kind==="approval"?"pendingApprovals":"pendingInputs";state.snapshot[key]=state.snapshot[key].filter(r=>r.id!==request.id);
  if(kind==="input")state.answers.delete(request.id);renderRequests();updateActivity();await snapshot(generation);return result;
 }catch(failure){if(generation===state.generation){error.textContent=failure.message||t.actionFailed;if(["NOT_FOUND","APPROVAL_STALE","APPROVAL_EXPIRED"].includes(failure.code))await snapshot(generation);}}
 finally{if(card.dataset.operation===operation){card.dataset.pending="false";buttons.forEach(b=>b.disabled=!state.capabilities.controls||Date.parse(request.expiresAt)<=Date.now());}}
}
function approvalCard(request){
 const card=node("section",undefined,"request-card");card.append(node("h2",request.title||t.approval),node("p",request.question||request.summary));
 card.append(node("p",[request.toolName,request.agentName,request.risk?t.risk+": "+(t[request.risk]||request.risk):"",t.expires+": "+new Date(request.expiresAt).toLocaleString()].filter(Boolean).join(" · "),"meta"));
 if(request.artifact){const artifact=node("details");artifact.append(node("summary",t.arguments));artifact.addEventListener("toggle",()=>{if(artifact.open&&artifact.children.length===1)artifact.append(node("pre",raw(request.artifact),"raw-text"));});card.append(artifact);}
 let mode;if(request.allowedPermissionModes?.length){const label=node("label",t.permission);mode=node("select");mode.setAttribute("aria-label",t.permission);for(const value of request.allowedPermissionModes){const option=node("option",t[value==="accept-edits"?"acceptEdits":value]||value);option.value=value;mode.append(option);}if(request.allowedPermissionModes.includes("ask"))mode.value="ask";label.append(mode);card.append(label);}
 const actions=node("div",undefined,"actions");for(const decision of request.allowedDecisions||[]){const label={"allow-once":"allowOnce","allow-session":"allowSession",deny:"deny",approve:"approve",reject:"reject"}[decision];const b=button(t[label]||decision,()=>respondRequest(card,"approval",request,{approvalId:request.id,decision,...(mode?{permissionMode:mode.value}:{}),context:context(request.revision)}));b.disabled=!state.capabilities.controls||Date.parse(request.expiresAt)<=Date.now();actions.append(b);}card.append(actions,node("p","","error"));return card;
}
function inputCard(request){
 const card=node("form",undefined,"request-card");card.append(node("h2",t.input));const saved=state.answers.get(request.id)||emptyDrafts(request.questions);state.answers.set(request.id,saved);
 request.questions.forEach((question,index)=>{const fieldset=node("fieldset");fieldset.append(node("legend",question.question));for(const option of question.options){const label=node("label",undefined,"choice");const input=node("input");input.type=question.multiSelect?"checkbox":"radio";input.name=question.id;input.value=option;input.checked=saved[index].values.includes(option);input.addEventListener("change",()=>{saved[index].values=question.multiSelect?[...fieldset.querySelectorAll("input:checked")].map(n=>n.value):[option];saved[index].skipped=false;if(!question.multiSelect){saved[index].customSelected=false;saved[index].customText="";free.value="";}});label.append(input,node("span",option));fieldset.append(label);}const free=node("input");free.type="text";free.value=saved[index].customText;free.placeholder=t.otherAnswer;free.setAttribute("aria-label",t.otherAnswer+": "+question.question);free.addEventListener("input",()=>{saved[index].customText=free.value;saved[index].customSelected=true;saved[index].skipped=false;if(!question.multiSelect){saved[index].values=[];fieldset.querySelectorAll("input").forEach(input=>input.checked=false);}});fieldset.append(free);card.append(fieldset);});
 const submit=node("button",t.submitAnswers,"primary");submit.type="submit";submit.disabled=!state.capabilities.controls||Date.parse(request.expiresAt)<=Date.now();const respond=answers=>respondRequest(card,"input",request,{inputId:request.id,answers,context:context()});
 card.addEventListener("submit",event=>{event.preventDefault();void respond(draftAnswers(saved));});const skip=button(t.skip,()=>respond(request.questions.map(()=>null)));skip.disabled=submit.disabled;card.append(submit,skip,node("p","","error"));return card;
}
function renderRequests(){
 const target=el("requests");const requests=[...(state.snapshot?.pendingApprovals||[]).map(request=>({request,kind:"approval"})),...(state.snapshot?.pendingInputs||[]).map(request=>({request,kind:"input"}))];const keys=new Set(requests.map(({request,kind})=>kind+":"+request.id));
 for(const[key,entry]of requestCards)if(!keys.has(key)){entry.card.remove();requestCards.delete(key);}
 requests.forEach(({request,kind},index)=>{const key=kind+":"+request.id;const fingerprint=raw({request,controls:state.capabilities.controls});let entry=requestCards.get(key);if(!entry||entry.fingerprint!==fingerprint){entry?.card.remove();entry={fingerprint,card:kind==="approval"?approvalCard(request):inputCard(request)};requestCards.set(key,entry);}if(target.children[index]!==entry.card)target.insertBefore(entry.card,target.children[index]||null);});
 const turns=state.snapshot?.queuedTurns||[];const fingerprint=raw(turns);const queue=el("queue");queue.hidden=!turns.length;if(fingerprint!==queueFingerprint){queueFingerprint=fingerprint;queue.replaceChildren();if(turns.length)queue.append(node("h2",t.queued));for(const turn of turns){const row=node("div",undefined,"queue-row");row.append(node("span",t.queuePosition+" "+(turn.queuePosition||"")+" · "+turn.id));if(state.capabilities.controls)row.append(button(t.prioritize,()=>mutate("turn/prioritize",{turnId:turn.id})),button(t.cancelTurn,()=>mutate("turn/cancel",{turnId:turn.id})));queue.append(row);}}
 updateComposer();
}
`;
