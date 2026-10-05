import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import jsQR from "jsqr";
import i18n from "i18next";
import type { AppSettings, ModelInfo, ProviderPublic, SessionSummary, ProjectWorkspace } from "@pi-desktop/shared";
import { ChatSurface } from "../components/ChatSurface";
import { ToastHost } from "../components/Toast";
import { Button, Input, PasswordInput, TooltipButton } from "../components/ui";
import { IconChevronLeft, IconCamera, IconClose, IconDiff, IconPlus, IconRefresh } from "../components/icons";
import { ReviewTab } from "../components/workpanel/ReviewTab";
import { FilesTab } from "../components/workpanel/FilesTab";
import { SubagentTranscriptTab } from "../components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../stores/app-store";
import { browserClient as client } from "./browser-client";
import { connectBrowserSession, setBrowserConnectionListener, stopBrowserSession } from "./store-bridge";
import { applyBrowserSettings } from "./browser-settings";

type PairPending={requestId:string;secret:string;verificationCode:string;expiresAt:string};
type Bootstrap={providers:ProviderPublic[];providerModels:Record<string,ModelInfo[]>;settings:AppSettings;projects:ProjectWorkspace[]};

function pairingToken(value:string) {
  if(/^https?:\/\//.test(value)) {
    const url=new URL(value);const params=new URLSearchParams(url.hash.slice(1));
    if(url.origin!==location.origin||url.pathname!=="/"||url.search||url.username||url.password||params.size!==2||params.getAll("pair").length!==1||params.getAll("expires").length!==1||(!Number.isFinite(Date.parse(params.get("expires")||""))||Date.parse(params.get("expires")||"")<=Date.now()))throw new Error("配对链接无效或已过期");
    const token=params.get("pair");if(!token||token.length>256)throw new Error(i18n.t("mobile.pairInvalid"));return token;
  }
  if(value.startsWith("{")) {
    const payload=JSON.parse(value);if(payload.kind!=="pi-mobile-pairing"||payload.version!==1||payload.origin!==location.origin||(!Number.isFinite(Date.parse(payload.expiresAt))||Date.parse(payload.expiresAt)<=Date.now()))throw new Error(i18n.t("mobile.pairInvalid"));return String(payload.token);
  }
  if(!value.trim()||value.length>256)throw new Error(i18n.t("mobile.pairInvalid"));return value.trim();
}

function PairBrowser({initialLink,onConnected}:{initialLink:string;onConnected:()=>Promise<void>}) {
  const {t}=useTranslation();
  const [manual,setManual]=useState(false);const [code,setCode]=useState("");const [label,setLabel]=useState(()=>t("mobile.deviceDefault"));const [pending,setPending]=useState<PairPending|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [seconds,setSeconds]=useState(0);const [scanning,setScanning]=useState(false);
  const attempt=useRef<{cancelled:boolean;pending?:PairPending;operation?:Promise<unknown>}|null>(null);const media=useRef<MediaStream|null>(null);const video=useRef<HTMLVideoElement>(null);
  const stopCamera=()=>{media.current?.getTracks().forEach(track=>track.stop());media.current=null;setScanning(false);};
  const cancel=async()=>{const current=attempt.current;if(!current)return;current.cancelled=true;try{await current.operation;}catch{/* A failed completion still needs cancellation. */}if(current.pending)await client.request("/v1/browser/pair/cancel",{requestId:current.pending.requestId,secret:current.pending.secret});attempt.current=null;setPending(null);setBusy(false);};
  const pair=async(value:string)=>{
    if(attempt.current)return;setError("");setBusy(true);const current:{cancelled:boolean;pending?:PairPending;operation?:Promise<unknown>}={cancelled:false};attempt.current=current;
    try {
      current.operation=client.request<PairPending>("/v1/browser/pair",{token:pairingToken(value),label});const result=await current.operation as PairPending;current.pending=result;setCode("");if(current.cancelled)return;setPending(result);
      while(!current.cancelled&&Date.now()<Date.parse(result.expiresAt)) {
        setSeconds(Math.max(0,Math.ceil((Date.parse(result.expiresAt)-Date.now())/1000)));
        current.operation=client.request<{status:string;csrf?:string}>("/v1/browser/pair/complete",{requestId:result.requestId,secret:result.secret});const completed=await current.operation as {status:string;csrf?:string};if(current.cancelled)return;
        if(completed.status==="approved"&&completed.csrf){client.csrf=completed.csrf;await onConnected();return;}
        if(completed.status==="rejected")throw new Error(t("mobile.pairRejected"));
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(!current.cancelled)throw new Error(t("mobile.pairExpired"));
    }catch(failure){if(!current.cancelled)setError((failure as {code?:string}).code==="PAIRING_FAILED"?i18n.t("mobile.pairInvalid"):String((failure as Error).message));}
    finally{if(attempt.current===current){attempt.current=null;setPending(null);setBusy(false);}}
  };
  const scan=async()=>{
    setError("");try {
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});media.current=stream;setScanning(true);await new Promise(requestAnimationFrame);const view=video.current!;view.srcObject=stream;await view.play();const canvas=document.createElement("canvas");const context=canvas.getContext("2d",{willReadFrequently:true})!;
      while(media.current===stream) {
        if(view.readyState>=2){canvas.width=Math.min(view.videoWidth,640);canvas.height=Math.round(view.videoHeight*canvas.width/view.videoWidth);context.drawImage(view,0,0,canvas.width,canvas.height);const pixels=context.getImageData(0,0,canvas.width,canvas.height);const match=jsQR(pixels.data,canvas.width,canvas.height);if(match){pairingToken(match.data);stopCamera();await pair(match.data);return;}}
        await new Promise(resolve=>setTimeout(resolve,150));
      }
    }catch(failure){stopCamera();setError((failure as Error).message);}
  };
  useEffect(()=>{if(initialLink)void pair(initialLink);return()=>{media.current?.getTracks().forEach(track=>track.stop());};},[]);
  return <div className="mobile-native-pair">
    <img src="/icon.svg" width="64" height="64" alt="PI-Desktop"/>
    <h1>PI-Desktop</h1>
    {pending?<><p>{t("mobile.approveDesktop")}</p><strong className="mobile-native-verification">{pending.verificationCode}</strong><time>{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,"0")}</time><Button variant="ghost" onClick={()=>void cancel()}>{t("common.cancel")}</Button></>:manual?<form onSubmit={event=>{event.preventDefault();void pair(code);}}><PasswordInput showLabel={t("mobile.showCode")} hideLabel={t("mobile.hideCode")} value={code} onChange={event=>setCode(event.target.value)} autoComplete="off" placeholder={t("mobile.pairCode")} required/><Input value={label} onChange={event=>setLabel(event.target.value)} maxLength={64} aria-label={t("mobile.deviceName")}/><Button variant="primary" type="submit" disabled={busy}>{t("mobile.connect")}</Button><Button variant="ghost" type="button" onClick={()=>setManual(false)}>{t("common.back",{defaultValue:"返回"})}</Button></form>:<><Button variant="primary" onClick={()=>void scan()} disabled={busy}><IconCamera size={18}/>{t("mobile.scan")}</Button><Button variant="ghost" onClick={()=>setManual(true)} disabled={busy}>{t("mobile.manual")}</Button></>}
    {error?<p role="alert" className="text-danger">{error}</p>:null}
    {scanning?<div><video ref={video} playsInline muted/><Button variant="ghost" onClick={stopCamera}>{t("common.cancel")}</Button></div>:null}
  </div>;
}

function WorkspaceChanges({sessionId}:{sessionId:string}) {
  const {t}=useTranslation();
  const [files,setFiles]=useState<Array<{path:string;status:string;additions?:number;deletions?:number}>>([]);const [hasMore,setHasMore]=useState(false);const [error,setError]=useState("");const [patches,setPatches]=useState<Record<string,string>>({});
  const load=async(offset=0)=>{try{const result=await client.request<{files:typeof files;nextOffset?:number}>(`/v1/sessions/${encodeURIComponent(sessionId)}/diff/list`,{offset,limit:100});setFiles(current=>offset?[...current,...result.files]:result.files);setHasMore(result.nextOffset!==undefined);setError("");}catch(failure){setError((failure as Error).message);}};
  const read=async(path:string)=>{const response=await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/diff/patch`,{method:"POST",credentials:"same-origin",headers:{"X-PI-Origin":location.origin,"X-PI-CSRF":client.csrf,"Content-Type":"application/json"},body:JSON.stringify({path})});if(!response.ok)throw new Error(response.statusText);return response.text();};
  useEffect(()=>{void load();},[sessionId]);
  return <section className="mobile-native-working-changes"><Button variant="ghost" onClick={()=>void load()}>{t("mobile.workingChanges")} <IconRefresh size={14}/></Button>{error?<p role="alert">{error}</p>:null}{files.map(file=><details key={file.path} onToggle={event=>{if(event.currentTarget.open&&!patches[file.path])void read(file.path).then(patch=>setPatches(current=>({...current,[file.path]:patch}))).catch(failure=>setError(failure.message));}}><summary>{file.path} <span className="diff-count-add">+{file.additions||0}</span> <span className="diff-count-del">−{file.deletions||0}</span></summary><pre>{patches[file.path]}</pre><Button variant="ghost" onClick={()=>void read(file.path).then(patch=>{const url=URL.createObjectURL(new Blob([patch],{type:"text/plain"}));const link=document.createElement("a");link.href=url;link.download=file.path.split(/[/\\]/).pop()+".patch";link.click();URL.revokeObjectURL(url);})}>{t("mobile.downloadPatch")}</Button></details>)}{hasMore?<Button variant="ghost" onClick={()=>void load(files.length)}>{t("mobile.loadMore")}</Button>:null}</section>;
}

export function BrowserApp({initialLink}:{initialLink:string}) {
  const {t}=useTranslation();const [paired,setPaired]=useState(false);const [showDraft,setShowDraft]=useState(false);const [status,setStatus]=useState("reconnecting");const [query,setQuery]=useState("");const [review,setReview]=useState(false);const [error,setError]=useState("");
  const sessions=useAppStore(state=>state.sessions);const active=useAppStore(state=>state.activeSessionId);const panelOpen=useAppStore(state=>state.workPanelOpen);const panelId=useAppStore(state=>state.activeWorkPanelTabId);
  const connect=async()=>{
    const bootstrap=await client.native<Bootstrap>("ui/bootstrap");useAppStore.setState({providers:bootstrap.providers,providerModels:bootstrap.providerModels,settings:applyBrowserSettings(bootstrap.settings),ready:true,healthOk:true,openProjects:bootstrap.projects,openProjectPaths:bootstrap.projects.map(project=>project.path)});await useAppStore.getState().refreshSessions();setPaired(true);setError("");
  };
  const home=()=>{setShowDraft(false);stopBrowserSession();useAppStore.setState({activeSessionId:undefined,messages:[],isRunning:false,workPanelOpen:false});setReview(false);};
  useEffect(()=>{
    client.onUnauthorized=()=>{stopBrowserSession();setPaired(false);};setBrowserConnectionListener(setStatus);
    if(!initialLink)void client.request<{csrf:string}>("/v1/browser/session").then(result=>{client.csrf=result.csrf;return connect();}).catch(failure=>{if((failure as {code?:string}).code!=="UNAUTHENTICATED")setError((failure as Error).message);});
    return stopBrowserSession;
  },[]);
  useEffect(()=>{setReview(false);if(active&&paired)void connectBrowserSession(active).catch(failure=>setError(failure.message));else {stopBrowserSession();client.sessionId="";}},[active,paired]);
  useEffect(()=>{const viewport=window.visualViewport;const resize=()=>document.documentElement.style.setProperty("--mobile-viewport-height",`${viewport?.height||innerHeight}px`);resize();viewport?.addEventListener("resize",resize);return()=>viewport?.removeEventListener("resize",resize);},[]);
  const select=async(session:SessionSummary)=>{try{setShowDraft(true);await useAppStore.getState().selectSession(session.id);}catch(failure){setError((failure as Error).message);}};
  return <div className="mobile-native-app">
    {paired?<><header className="mobile-native-header"><TooltipButton className="icon-btn" tooltip={t("common.back",{defaultValue:"返回"})} ariaLabel={t("common.back",{defaultValue:"返回"})} onClick={home}><IconChevronLeft size={18}/></TooltipButton><h1>{sessions.find(session=>session.id===active)?.title||"PI-Desktop"}</h1><span className="mobile-native-connection" data-status={status} title={t("mobile."+status)}/>{active?<TooltipButton className="icon-btn" tooltip={t("panel.review.title",{defaultValue:"审阅"})} ariaLabel={t("panel.review.title",{defaultValue:"审阅"})} onClick={()=>setReview(value=>!value)}><IconDiff size={18}/></TooltipButton>:null}<TooltipButton className="icon-btn" tooltip={t("chat.newTask",{defaultValue:"新任务"})} ariaLabel={t("chat.newTask",{defaultValue:"新任务"})} onClick={()=>{setShowDraft(true);void useAppStore.getState().newSession();}}><IconPlus size={18}/></TooltipButton></header>
    {error?<p className="mobile-native-error" role="alert">{error}</p>:null}
    {active||showDraft?<main className="mobile-native-chat"><div className={review?"mobile-native-hidden":"mobile-native-surface"}><ChatSurface/></div>{review&&active?<div className="mobile-native-review"><ReviewTab/><WorkspaceChanges sessionId={active}/></div>:null}</main>:<main className="mobile-native-home"><Input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder={t("chat.searchSessions",{defaultValue:"搜索任务"})}/><div className="mobile-native-sessions">{sessions.filter(session=>(session.title||"").toLowerCase().includes(query.toLowerCase())).map(session=><Button key={session.id} variant="ghost" onClick={()=>void select(session)}>{session.title||t("chat.untitledTask")}</Button>)}</div><Button variant="ghost" onClick={()=>void client.request("/v1/browser/logout",{}).then(()=>{client.csrf="";setPaired(false);home();})}>{t("mobile.disconnect")}</Button></main>}
    {panelOpen&&active?<section className="mobile-native-panel"><header><TooltipButton className="icon-btn" tooltip={t("common.close")} ariaLabel={t("common.close")} onClick={()=>useAppStore.setState({workPanelOpen:false})}><IconClose size={18}/></TooltipButton></header>{panelId?.startsWith("subagent:")?<SubagentTranscriptTab delegationId={panelId.slice(9)}/>:panelId==="review"?<ReviewTab/>:<FilesTab/>}</section>:null}
    <ToastHost/></>:<PairBrowser initialLink={initialLink} onConnected={connect}/>}
  </div>;
}
