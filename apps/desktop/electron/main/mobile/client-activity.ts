/** Display the runtime's actual phase and the active turn's elapsed time. */
export const mobileActivityScript = String.raw`
let activityTimer=null;
function stopActivity() {clearTimeout(activityTimer);activityTimer=null;state.runtimeActivity=null;state.responsePhase=null;state.activityTurnId=null;state.activityObservedAt=null;}
function acceptTurn(turn) {if(turn?.status!=="queued"){state.snapshot ||= {pendingApprovals:[],pendingInputs:[],queuedTurns:[]};state.snapshot.activeTurn=turn;state.runtimeActivity={phase:"waiting-model",since:Date.now()};updateActivity();}}
function updateActivity() {
 clearTimeout(activityTimer);activityTimer=null;if(!state.current)return;
 const turn=state.snapshot?.activeTurn;const pending=state.snapshot?.pendingApprovals?.length||state.snapshot?.pendingInputs?.length;
 if(!turn){el("activity").textContent=state.current.workspaceLabel||t.idle;return;}
 if(state.activityTurnId!==turn.id){state.activityTurnId=turn.id;state.activityObservedAt=Date.now();}
 const phase=state.runtimeActivity?.phase;
 const labels={starting:t.starting,"waiting-model":t.waitingModel,preparing:t.preparing,compacting:t.compact,recovering:t.recovering,retrying:t.retrying,"waiting-subagents":t.waitingSubagents};
 const label=pending?t.waiting:labels[phase]||t[state.responsePhase]||t.waitingModel;
 const since=Date.parse(turn.startedAt)||state.runtimeActivity?.since||state.activityObservedAt;
 const seconds=since?Math.max(0,Math.floor((Date.now()-since)/1000)):0;const elapsed=Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");
 const model=selectedModel(el("model"))?.name||state.current.modelId||"";el("activity").textContent=[model,label,elapsed].filter(Boolean).join(" · ");
 if(!document.hidden)activityTimer=setTimeout(updateActivity,1000);
}
function observeActivity(envelope) {
 const event=envelope.payload?.event;
 if(event?.type==="status"){state.runtimeActivity=event.status.activity||null;if(!event.status.isRunning)state.responsePhase=null;}
 if(event?.type==="message_update"){state.runtimeActivity=null;state.responsePhase=event.deltaText||event.message?.content?"responding":"thinkingNow";}
 if(["tool_start","tool_update"].includes(event?.type)){state.runtimeActivity=null;state.responsePhase="toolRunning";}
 if(envelope.kind==="turn.started"&&envelope.payload?.turn)acceptTurn(envelope.payload.turn);
 if(["turn.completed","turn.failed","turn.canceled","turn.interrupted"].includes(envelope.kind)){if(state.snapshot?.activeTurn?.id===envelope.turnId)state.snapshot.activeTurn=null;state.runtimeActivity=null;state.responsePhase=null;}
 updateActivity();
}
`;
