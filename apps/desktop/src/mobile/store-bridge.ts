import { IPC, type AgentEvent, type AgentStatus, type RacpEventEnvelope, type RacpSessionSnapshot, type SessionTodoSnapshot, type UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { browserClient as client } from "./browser-client";
import { emitBrowserEvent } from "./browser-bridge";

let generation=0;
let stream:AbortController|null=null;
let retryTimer:ReturnType<typeof setTimeout>|undefined;
let todoTimer:ReturnType<typeof setTimeout>|undefined;
let cursor: {epoch:string;sequence:number}|undefined;
let onConnection:(status:string)=>void=()=>{};

async function refreshInteractive(sessionId:string) {
  await Promise.all([useAppStore.getState().restorePendingInteractive(sessionId),useAppStore.getState().restorePendingPlan(sessionId),useAppStore.getState().refreshQueuedPrompts(sessionId)]);
}
async function refreshTodos(sessionId:string,version:number) {
  try {
    const snapshot=await client.native<SessionTodoSnapshot>("ui/todos/get",{sessionId});
    if(version===generation)useAppStore.getState().applyTodosChanged(snapshot);
  } catch(error) {if(version===generation)console.error(error);}
  if(version===generation && !document.hidden && useAppStore.getState().runningSessions[sessionId])todoTimer=setTimeout(()=>void refreshTodos(sessionId,version),2000);
}
async function refreshStatus(sessionId:string,version:number) {
  const {status}=await client.native<{status:AgentStatus}>("ui/session/status",{sessionId});
  if(version===generation)useAppStore.setState(state=>({agentStatuses:{...state.agentStatuses,[sessionId]:status}}));
}
function applySnapshot(snapshot:RacpSessionSnapshot) {
  const id=snapshot.session.id;
  const running=!!snapshot.activeTurn;
  useAppStore.setState(state=>({runningSessions:{...state.runningSessions,[id]:running},...(state.activeSessionId===id?{isRunning:running}:{}),agentStatuses:{...state.agentStatuses,[id]:{...state.agentStatuses[id],isRunning:running}}}));
  for(const item of snapshot.activeItems) {
    const content=item.content as UiMessage & {toolCallId:string;toolName:string;args:unknown;partialResult?:unknown};
    const message:UiMessage=item.itemType==="tool"?{id:item.id,role:"tool",content:typeof content.partialResult==="string"?content.partialResult:"",createdAt:item.createdAt,toolCallId:content.toolCallId,toolName:content.toolName,toolArgs:content.args,toolResult:content.partialResult,toolStatus:"running",status:"streaming",parentToolCallId:item.parentToolCallId,nestedParentToolCallId:item.nestedParentToolCallId,agentName:item.agentName}:content;
    if(item.itemType!=="tool" && !message.role)continue;
    useAppStore.getState().handleAgentEvent({sessionId:id,turnId:item.turnId,ts:Date.parse(item.createdAt),event:{type:"message_update",message},parentToolCallId:item.parentToolCallId,nestedParentToolCallId:item.nestedParentToolCallId,agentName:item.agentName});
  }
}
function observe(envelope:RacpEventEnvelope) {
  const payload=envelope.payload as {event?:AgentEvent};
  if(payload.event)useAppStore.getState().handleAgentEvent({sessionId:envelope.sessionId!,turnId:envelope.turnId,ts:Date.parse(envelope.occurredAt)||Date.now(),event:payload.event,parentToolCallId:envelope.parentToolCallId,nestedParentToolCallId:envelope.nestedParentToolCallId,agentName:envelope.agentName});
  if(envelope.kind.startsWith("approval.")||envelope.kind.startsWith("input."))void refreshInteractive(envelope.sessionId!);
  if(envelope.kind.startsWith("turn."))void useAppStore.getState().refreshQueuedPrompts(envelope.sessionId!);
  if(["turn.completed","turn.failed","turn.canceled","turn.interrupted"].includes(envelope.kind)) {
    useAppStore.getState().handleAgentEvent({sessionId:envelope.sessionId!,turnId:envelope.turnId,ts:Date.now(),event:{type:"agent_end",messageIds:[]}});
    void refreshTodos(envelope.sessionId!,generation);
  }
  if(payload.event?.type==="tool_end")void refreshTodos(envelope.sessionId!,generation);
  emitBrowserEvent(IPC.event.agentMessage,{sessionId:envelope.sessionId,turnId:envelope.turnId,event:payload.event,ts:Date.now()});
}
async function follow(sessionId:string,version:number,resume=false) {
  if(version!==generation || document.hidden)return;
  stream?.abort();stream=new AbortController();const current=stream;
  try {
    if(resume) {
      const snapshot=await client.snapshot(sessionId);if(version!==generation)return;
      await useAppStore.getState().selectSession(sessionId,{record:false});if(version!==generation)return;
      applySnapshot(snapshot);cursor=snapshot.cursor;
      await refreshInteractive(sessionId);await refreshStatus(sessionId,version);
    }
    const response=await fetch("/v1/sessions/"+encodeURIComponent(sessionId)+"/events",{credentials:"same-origin",cache:"no-store",signal:current.signal,headers:{"X-PI-Origin":location.origin,...(cursor?{"Last-Event-ID":cursor.epoch+":"+cursor.sequence}:{})}});
    if(response.status===401){client.csrf="";client.onUnauthorized();return;}
    if(!response.ok||!response.body)throw new Error(response.statusText);
    onConnection("connected");const reader=response.body.getReader();const decoder=new TextDecoder();let buffer="";
    while(version===generation) {
      const chunk=await reader.read();if(chunk.done)break;if(version!==generation){await reader.cancel();return;}
      buffer+=decoder.decode(chunk.value,{stream:true}).replace(/\r\n/g,"\n");let boundary;let frames=0;
      while((boundary=buffer.indexOf("\n\n"))>=0) {
        const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        const lines=frame.split("\n");const kind=lines.find(line=>line.startsWith("event: "))?.slice(7);const data=lines.filter(line=>line.startsWith("data: ")).map(line=>line.slice(6)).join("\n");
        if(kind==="resync") {const snapshot=await client.snapshot(sessionId);if(version!==generation)return;applySnapshot(snapshot);cursor=snapshot.cursor;await useAppStore.getState().selectSession(sessionId,{record:false});await refreshInteractive(sessionId);}
        if(kind==="racp"&&data) {const envelope=JSON.parse(data) as RacpEventEnvelope;if(envelope.sequence===undefined||!cursor||cursor.epoch!==envelope.epoch||envelope.sequence>cursor.sequence){observe(envelope);if(envelope.sequence!==undefined)cursor={epoch:envelope.epoch,sequence:envelope.sequence};}}
        if(++frames%32===0)await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
  } catch(error) {if(version===generation&&!current.signal.aborted){onConnection("offline");console.error(error);}}
  if(version===generation&&!document.hidden&&client.csrf)retryTimer=setTimeout(()=>void follow(sessionId,version,true),2000);
}
export function stopBrowserSession() {generation++;stream?.abort();stream=null;clearTimeout(retryTimer);clearTimeout(todoTimer);cursor=undefined;}
export async function connectBrowserSession(sessionId:string) {
  stopBrowserSession();client.sessionId=sessionId;if(!sessionId)return;
  const version=generation;onConnection("reconnecting");
  const snapshot=await client.snapshot(sessionId);if(version!==generation)return;applySnapshot(snapshot);cursor=snapshot.cursor;
  void refreshInteractive(sessionId);void refreshTodos(sessionId,version);void refreshStatus(sessionId,version).catch(console.error);void follow(sessionId,version);
}
export function setBrowserConnectionListener(listener:(status:string)=>void) {onConnection=listener;}
document.addEventListener("visibilitychange",()=>{const id=useAppStore.getState().activeSessionId;if(document.hidden){generation++;stream?.abort();clearTimeout(retryTimer);clearTimeout(todoTimer);}else if(id&&client.csrf){void follow(id,generation,true);void refreshTodos(id,generation);}});
window.addEventListener("pagehide",stopBrowserSession);
