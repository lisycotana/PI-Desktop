/** Device credentials remain in HttpOnly cookies; QR materials stay in memory. */
export const mobilePairingScript = String.raw`
function pairingToken(input) {
 const value = input.trim();
 if (/^https?:\/\//i.test(value)) {
  let url;try {url = new URL(value);decodeURIComponent(url.hash.slice(1));}catch {throw new Error(t.pairInvalid);}
  if (url.origin !== location.origin) throw new Error(t.pairOriginMismatch);
  const params = new URLSearchParams(url.hash.slice(1));
  if (url.pathname !== "/" || url.search || url.username || url.password || params.size !== 2 || params.getAll("pair").length !== 1 || params.getAll("expires").length !== 1) throw new Error(t.pairInvalid);
  const token = params.get("pair");const expiry = Date.parse(params.get("expires"));
  if (!token || token.length > 256 || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error(t.pairInvalid);
  return token;
 }
 if (!value.startsWith("{")) {if (!value || value.length > 256) throw new Error(t.pairInvalid);return value;}
 let payload;try {payload = JSON.parse(value);}catch {throw new Error(t.pairInvalid);}
 if (payload.kind !== "pi-mobile-pairing" || payload.version !== 1 || typeof payload.token !== "string" || !payload.token || payload.token.length > 256 || !Number.isFinite(Date.parse(payload.expiresAt))) throw new Error(t.pairInvalid);
 if (payload.origin !== location.origin) throw new Error(t.pairOriginMismatch);
 if (Date.parse(payload.expiresAt) <= Date.now()) throw new Error(t.pairInvalid);
 return payload.token;
}
let pairingAttempt = null;
function pairingScreen(name) {
 el("pair-start").hidden = name !== "start";el("pair-form").hidden = name !== "manual";el("pair-pending").hidden = name !== "pending";
 if (name !== "manual") {el("code").type = "password";el("code-visibility").replaceChildren(icon("eye"));el("code-visibility").setAttribute("aria-label",t.showCode);el("code-visibility").setAttribute("aria-pressed","false");}
}
async function pairFromLink(value) {
 try {pairingToken(value);el("code").value = value;await pairBrowser();}
 catch(error) {el("pair-error").textContent = error.message;}
}
function pairingError(error, pending) {return error.code === "PAIRING_FAILED" ? pending ? t.pairExpired : t.pairInvalid : error.message;}
function pairingCountdown(pending) {
 const seconds = Math.max(0,Math.ceil((Date.parse(pending.expiresAt)-Date.now())/1000));
 el("pair-countdown").textContent = Math.floor(seconds/60) + ":" + String(seconds%60).padStart(2,"0");el("pair-countdown").dateTime = pending.expiresAt;
}
async function cancelPairing() {
 const attempt = pairingAttempt;if (!attempt || attempt.cancelled) return;
 attempt.cancelled = true;el("pair-cancel").disabled = true;
 // Cancel after the current response; the server also revokes a completed receipt.
 try {
  try {await attempt.operation;}catch { /* Cancellation still invalidates the pending request. */ }
  if (attempt.pending) await api("/v1/browser/pair/cancel",{quietAuth:true,method:"POST",body:JSON.stringify({requestId:attempt.pending.requestId,secret:attempt.pending.secret})});
  state.csrf = "";
  el("pair-error").textContent = t.pairCancelled;
 } catch(error) {el("pair-error").textContent = pairingError(error,!!attempt.pending);}
 finally {if (pairingAttempt === attempt) {pairingAttempt = null;pairingScreen("start");el("pair-cancel").disabled = false;}}
}
async function pairBrowser(event) {
 event?.preventDefault();if (pairingAttempt) return;
 el("pair-error").textContent = "";el("pair-button").disabled = true;el("scan-qr").disabled = true;const generation = state.generation;
 const attempt = {cancelled:false,pending:null,operation:null};pairingAttempt = attempt;
 try {
  const token = pairingToken(el("code").value);
  attempt.operation = api("/v1/browser/pair",{quietAuth:true,method:"POST",body:JSON.stringify({token,label:el("pair-label").value.trim() || t.defaultDevice})});
  const pending = await attempt.operation;attempt.pending = pending;el("code").value = "";
  if (!/^[0-9]{6}$/.test(pending.verificationCode) || typeof pending.requestId !== "string" || typeof pending.secret !== "string" || !Number.isFinite(Date.parse(pending.expiresAt))) throw new Error(t.pairInvalid);
  if (attempt.cancelled || generation !== state.generation) return;
  el("pair-verification").textContent = pending.verificationCode;pairingCountdown(pending);pairingScreen("pending");
  while (!attempt.cancelled && generation === state.generation && Date.now() < Date.parse(pending.expiresAt)) {
   attempt.operation = api("/v1/browser/pair/complete",{quietAuth:true,method:"POST",body:JSON.stringify({requestId:pending.requestId,secret:pending.secret})});
   const result = await attempt.operation;
   if (attempt.cancelled || generation !== state.generation) return;
   if (result.status === "rejected") throw new Error(t.pairRejected);
   if (result.status === "approved" && result.csrf) {state.csrf = result.csrf;await list();return;}
   if (result.status !== "pending") throw new Error(t.pairInvalid);
   await new Promise(resolve => setTimeout(resolve,1000));pairingCountdown(pending);
  }
  if (!attempt.cancelled && generation === state.generation) throw new Error(t.pairExpired);
 } catch(error) {if (!attempt.cancelled && generation === state.generation) {el("pair-error").textContent = pairingError(error,!!attempt.pending);pairingScreen(attempt.pending ? "start" : "manual");}}
 finally {if (!attempt.cancelled && pairingAttempt === attempt) pairingAttempt = null;el("pair-button").disabled = false;el("scan-qr").disabled = false;}
}
function stopQrReader() {state.qrReader?.getTracks().forEach(track => track.stop());state.qrReader = null;el("qr-video").srcObject = null;el("qr-reader").hidden = true;}
async function scanPairingQr() {
 stopQrReader();el("pair-error").textContent = "";pairingScreen("start");
 try {
  const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});state.qrReader = stream;
  const video = el("qr-video");video.srcObject = stream;el("qr-reader").hidden = false;await video.play();
  const canvas = document.createElement("canvas");const context = canvas.getContext("2d",{willReadFrequently:true});
  while (state.qrReader === stream) {
   if (video.readyState >= 2) {canvas.width = Math.min(video.videoWidth,640);canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);context.drawImage(video,0,0,canvas.width,canvas.height);const pixels = context.getImageData(0,0,canvas.width,canvas.height);const match = window.jsQR(pixels.data,canvas.width,canvas.height);if (match) {pairingToken(match.data);el("code").value = match.data;stopQrReader();await pairBrowser();return;}}
   await new Promise(resolve => setTimeout(resolve,150));
  }
 } catch(error) {stopQrReader();el("pair-error").textContent = error.name === "NotAllowedError" ? t.cameraDenied : error.name === "NotFoundError" ? t.cameraMissing : error.message;}
}
function initPairing() {
 el("pair-label").value = t.defaultDevice;el("pair-form").addEventListener("submit",pairBrowser);
 el("pair-manual").addEventListener("click",() => {el("pair-error").textContent = "";pairingScreen("manual");el("code").focus();});
 el("pair-form-close").addEventListener("click",() => {el("code").value = "";el("pair-error").textContent = "";pairingScreen("start");});
 el("pair-cancel").addEventListener("click",cancelPairing);
 el("code-visibility").addEventListener("click",() => {const visible = el("code").type === "password";el("code").type = visible ? "text" : "password";el("code-visibility").replaceChildren(icon(visible ? "eyeOff" : "eye"));el("code-visibility").setAttribute("aria-label",visible ? t.hideCode : t.showCode);el("code-visibility").setAttribute("aria-pressed",String(visible));});
 el("scan-qr").addEventListener("click",scanPairingQr);el("qr-close").addEventListener("click",stopQrReader);
 window.addEventListener("pagehide",stopQrReader);
}
`;
