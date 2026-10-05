import { app, BrowserWindow, clipboard, dialog, Menu, nativeTheme, type MessageBoxOptions } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { builtinWindowBackground } from "@pi-desktop/shared";
import QRCode from "qrcode";
import { mobileIcon } from "./client-icons";
import type { MobilePairingDecision } from "./browser-auth";

export type MobilePairingInfo = { origin: string; token: string; expiresAt: string };
export type MobilePairedBrowser = { id: string; label: string; createdAt: string; expiresAt: string };
export type MobilePairingUiService = {
  getPairing(): MobilePairingInfo;
  issuePairing(): MobilePairingInfo | Promise<MobilePairingInfo>;
  listBrowsers(): MobilePairedBrowser[];
  revokeBrowser(id: string): boolean;
};
export type MobilePairingConfirmation = {
  origin: string;
  label: string;
  userAgent: string;
  verificationCode: string;
  expiresAt: string;
  roles: readonly string[];
  signal?: AbortSignal;
};

const PAIRING_LIFETIME_MS = 2 * 60_000;
const NEW_CODE_ACTION = "https://pairing-action.invalid/new-code";
const COPY_CODE_ACTION = "https://pairing-action.invalid/copy-code";
const COPY_LINK_ACTION = "https://pairing-action.invalid/copy-link";
const TOGGLE_CODE_ACTION = "https://pairing-action.invalid/toggle-code";
const copies = {
  en: {
    title: "PI Mobile pairing", heading: "Pair phone",
    origin: "Address", expires: "Expires",
    code: "Pairing code",
    showCode: "Show pairing code", hideCode: "Hide pairing code", copyCode: "Copy code", copyLink: "Copy link", copiedCode: "Code copied", copiedLink: "Link copied",
    expired: "Pairing code expired",
    newCode: "New code", newCodeFailed: "Could not create a new code.",
    access: "Granted access", viewer: "View task history and workspace files", controller: "Create tasks, send messages, and stop work", approver: "Respond to tool and task approvals",
    taskControl: "Personal task control: choose Ask, Accept edits, or Full auto per conversation; allow a tool once, reject it, or allow it for this conversation. Desktop policy and tool safety rules still apply.",
    confirmTitle: "Approve this phone browser?", confirm: "Compare verification code",
    verification: "Verification code", label: "Browser-supplied label (unverified)", userAgent: "Browser-supplied user agent (unverified)",
    reject: "Reject", allow: "Approve browser", unavailable: "The mobile companion is unavailable.",
    failed: "The pairing window could not be opened. Try again from the desktop mobile menu.",
    browsers: "Paired phone browsers", none: "No paired browsers have active access.", created: "Paired", revoke: "Revoke access",
    revokeTitle: "Revoke this browser's access?", revokeDetail: "This browser will be disconnected. Pair it again to restore access.",
    cancel: "Cancel", revoked: "Browser access revoked.", alreadyRevoked: "This browser no longer has active access.", ok: "OK",
  },
  zh: {
    title: "PI 手机配对", heading: "配对手机",
    origin: "地址", expires: "到期时间",
    code: "配对码",
    showCode: "显示配对码", hideCode: "隐藏配对码", copyCode: "复制配对码", copyLink: "复制链接", copiedCode: "已复制配对码", copiedLink: "已复制链接",
    expired: "配对码已过期",
    newCode: "新二维码", newCodeFailed: "无法生成新二维码。",
    access: "授予的权限", viewer: "查看任务历史和工作区文件", controller: "创建任务、发送消息及停止工作", approver: "处理工具和任务审批",
    taskControl: "个人任务控制：可为每个对话选择每次询问、接受编辑或全自动；可拒绝工具、仅允许一次或允许本次对话。仍受桌面策略和工具安全规则约束。",
    confirmTitle: "批准此手机浏览器？", confirm: "核对验证码",
    verification: "验证码", label: "浏览器自报名称（未经验证）", userAgent: "浏览器自报用户代理（未经验证）",
    reject: "拒绝", allow: "批准浏览器", unavailable: "手机伴侣暂不可用。",
    failed: "无法打开配对窗口，请从桌面的手机菜单重试。",
    browsers: "已配对的手机浏览器", none: "当前没有获得访问权限的浏览器。", created: "配对时间", revoke: "撤销访问权限",
    revokeTitle: "撤销此浏览器的访问权限？", revokeDetail: "此浏览器将断开连接。如需恢复访问，请重新配对。",
    cancel: "取消", revoked: "已撤销浏览器访问权限。", alreadyRevoked: "此浏览器已无访问权限。", ok: "确定",
  },
} as const;

function copy(locale: string) { return copies[locale.toLowerCase().startsWith("zh") ? "zh" : "en"]; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char); }
function claim(value: string, limit = 500): string {
  // Quote line breaks and remove direction controls so a claim cannot relabel the prompt.
  return JSON.stringify(value.replace(/[\u202a-\u202e\u2066-\u2069]/g, "").slice(0, limit)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + (value.length > limit ? "…" : "");
}
function isOrigin(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && url.origin === value && !url.username && !url.password; } catch { return false; }
}
function remaining(expiresAt: string): number { return Date.parse(expiresAt) - Date.now(); }

/** The one-use bootstrap stays in the fragment; HTTP requests never carry it. */
export function mobilePairingQrPayload(info: MobilePairingInfo): string {
  if (!isOrigin(info.origin) || !info.token || !Number.isFinite(Date.parse(info.expiresAt))) throw new Error("Invalid mobile pairing information");
  const url = new URL(info.origin);
  url.hash = new URLSearchParams({pair:info.token,expires:info.expiresAt}).toString();
  return url.href;
}

export function mobilePairingConfirmationOptions(request: MobilePairingConfirmation, locale: string): MessageBoxOptions {
  const strings = copy(locale);
  return {
    type: "warning", title: strings.confirmTitle, message: strings.confirm,
    detail: [
      `${strings.verification}: ${request.verificationCode}`,
      `${strings.origin}: ${request.origin}`,
      `${strings.label}: ${claim(request.label, 200)}`,
      `${strings.userAgent}: ${claim(request.userAgent)}`,
      `${strings.access}:\n${request.roles.map(role => strings[role as "viewer" | "controller" | "approver"] || role).join("\n")}`,
      strings.taskControl,
      `${strings.expires}: ${new Date(request.expiresAt).toLocaleString(locale)}`,
    ].join("\n\n"),
    buttons: [strings.reject, strings.allow], defaultId: 0, cancelId: 0, noLink: true,
  };
}

function pairingShell(locale: string): string {
  const strings = copy(locale);
  const dark = nativeTheme.shouldUseDarkColors;
  const background = builtinWindowBackground(dark ? "dark" : "light");
  return `<!doctype html><html lang="${locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'"><meta name="color-scheme" content="${dark ? "dark" : "light"}"><title>${escapeHtml(strings.title)}</title><style>
  *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding:24px 28px;font:14px system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;background:${background};color:${dark ? "#ededed" : "#252525"}}header{display:flex;align-items:center;gap:10px;font-weight:600}header img{width:28px;height:28px}h1{font-size:21px;font-weight:600;line-height:1.35;margin:18px 0 12px}.qr{display:block;width:248px;height:248px;max-width:100%;margin:16px auto;padding:8px;border-radius:12px;background:white}.address{display:block;overflow-wrap:anywhere;font:13px ui-monospace,monospace;color:inherit;user-select:text}.code-field{position:relative}.code-field input{padding-right:44px}.eye{position:absolute;right:4px;top:4px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;color:inherit;border-radius:6px}.eye:hover{background:${dark ? "#333" : "#eee"}}label{display:block;font-size:12px;margin-top:14px}input{width:100%;padding:11px;font:14px ui-monospace,monospace;border:1px solid ${dark ? "#444" : "#ddd"};border-radius:8px;background:transparent;color:inherit}input:focus,.action:focus{outline:2px solid ${dark ? "#ededed" : "#252525"};outline-offset:2px}.metadata{font-size:12px;color:${dark ? "#b3b3b3" : "#666"}}#expiry{font-variant-numeric:tabular-nums}.actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:16px}.action{display:inline-block;padding:8px 14px;border:1px solid ${dark ? "#555" : "#ccc"};border-radius:8px;color:inherit;text-decoration:none;background:${dark ? "#333" : "#f5f5f5"}}#status{min-height:20px;margin-top:10px;color:${dark ? "#b3b3b3" : "#666"}}</style></head><body><header><img id="brand-icon" hidden alt=""><span>PI Desktop</span></header><h1>${escapeHtml(strings.heading)}</h1><label>${escapeHtml(strings.origin)}<span id="origin" class="address"></span></label><img id="qr" class="qr" alt="${escapeHtml(strings.code)}"><div class="metadata">${escapeHtml(strings.expires)}: <time id="expiry"></time></div><label for="pairing-code">${escapeHtml(strings.code)}</label><div class="code-field"><input id="pairing-code" type="password" readonly autocomplete="off" spellcheck="false"><a id="code-visibility" class="eye" href="${TOGGLE_CODE_ACTION}" aria-label="${escapeHtml(strings.showCode)}" aria-pressed="false">${mobileIcon("eye",18)}</a></div><div class="actions"><a class="action" href="${COPY_CODE_ACTION}">${escapeHtml(strings.copyCode)}</a><a class="action" href="${COPY_LINK_ACTION}">${escapeHtml(strings.copyLink)}</a><a class="action" href="${NEW_CODE_ACTION}">${escapeHtml(strings.newCode)}</a></div><div id="status" role="status"></div></body></html>`;
}

function appIcon(): { path?: string; dataUrl?: string } {
  const path = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build"), app.isPackaged ? "tray-icon.png" : "icon.png");
  return existsSync(path) ? { path, dataUrl: `data:image/png;base64,${readFileSync(path).toString("base64")}` } : {};
}

export function createMobilePairingUi(deps: {
  getService: () => MobilePairingUiService | undefined;
  getMainWindow: () => BrowserWindow | null;
  getLocale: () => string;
}) {
  let pairingWindow: BrowserWindow | null = null;
  let pairingExpiresAt = "";
  let pairingInfo: MobilePairingInfo | null = null;
  let expiryTimer: NodeJS.Timeout | null = null;
  let opening: Promise<void> | null = null;
  let browserMenu: Menu | null = null;
  let closed = false;
  let generation = 0;
  const dialogs = new Set<AbortController>();

  function abortDialogs() { for (const controller of dialogs) controller.abort(); }
  function clearExpiryTimer() { if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = null; }
  function countdown(milliseconds: number): string {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function armExpiry(window: BrowserWindow, info: MobilePairingInfo, locale: string): void {
    clearExpiryTimer();
    const tick = () => {
      if (closed || pairingWindow !== window || window.isDestroyed() || pairingExpiresAt !== info.expiresAt) { clearExpiryTimer(); return; }
      const left = remaining(info.expiresAt);
      if (left <= 0) {
        clearExpiryTimer(); abortDialogs(); pairingInfo = null;
        void window.webContents.executeJavaScript(`document.getElementById("qr").removeAttribute("src");document.getElementById("qr").hidden=true;document.getElementById("pairing-code").value="";document.getElementById("expiry").textContent="0:00";document.getElementById("status").textContent=${JSON.stringify(copy(locale).expired)};`).catch(() => { if (!window.isDestroyed()) window.destroy(); });
        return;
      }
      void window.webContents.executeJavaScript(`document.getElementById("expiry").textContent=${JSON.stringify(countdown(left))};`).catch(() => { if (!window.isDestroyed()) window.destroy(); });
      expiryTimer = setTimeout(tick, Math.min(1000, left));
    };
    tick();
  }
  function liveParent() { const window = deps.getMainWindow(); return window && !window.isDestroyed() ? window : null; }
  function isCurrentService(service: MobilePairingUiService) {
    const current = deps.getService();
    // Bootstrap may return a fresh facade; these methods identify its underlying listener.
    return !!current && current.getPairing === service.getPairing && current.revokeBrowser === service.revokeBrowser;
  }
  async function message(options: MessageBoxOptions) { const parent = liveParent(); return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options); }
  async function unavailable() { if (!closed) { const strings = copy(deps.getLocale()); await message({ type: "info", title: strings.title, message: strings.unavailable, buttons: [strings.ok] }); } }

  async function confirmPairing(request: MobilePairingConfirmation): Promise<MobilePairingDecision> {
    const service = deps.getService();
    if (closed || request.signal?.aborted || !service || !/^\d{6}$/.test(request.verificationCode) || !isOrigin(request.origin) || service.getPairing().origin !== request.origin || remaining(request.expiresAt) <= 0 || remaining(request.expiresAt) > PAIRING_LIFETIME_MS || !Number.isFinite(remaining(request.expiresAt)) || !request.roles.length || request.roles.some(role => !["viewer", "controller", "approver"].includes(role))) return false;
    // The server consumed this code before requesting desktop confirmation.
    if (pairingWindow && !pairingWindow.isDestroyed()) pairingWindow.destroy();
    const current = generation;
    const controller = new AbortController(); dialogs.add(controller);
    const requestAborted = () => controller.abort();
    request.signal?.addEventListener("abort", requestAborted, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.min(remaining(request.expiresAt), PAIRING_LIFETIME_MS));
    const parent = liveParent();
    const parentClosed = () => controller.abort(); parent?.once("closed", parentClosed);
    try {
      const options = { ...mobilePairingConfirmationOptions(request, deps.getLocale()), signal: controller.signal };
      const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      const approved = result.response === 1 && !controller.signal.aborted && !closed && current === generation && remaining(request.expiresAt) > 0 && isCurrentService(service) && (!parent || !parent.isDestroyed());
      return approved
        ? { approved: true, taskControl: { maxPermissionMode: "auto", allowSessionGrants: true } }
        : false;
    } finally { clearTimeout(timer); request.signal?.removeEventListener("abort", requestAborted); parent?.removeListener("closed", parentClosed); dialogs.delete(controller); }
  }

  function showPairing(forceRenew = false): Promise<void> {
    if (closed) return Promise.resolve();
    if (!forceRenew && pairingWindow && !pairingWindow.isDestroyed() && remaining(pairingExpiresAt) > 0) { pairingWindow.show(); pairingWindow.focus(); return Promise.resolve(); }
    if (opening) return opening;
    const creation = (async () => {
      const service = deps.getService(); if (!service) { await unavailable(); return; }
      generation++; abortDialogs(); pairingInfo = null;
      const current = generation;
      const reusable = forceRenew && pairingWindow && !pairingWindow.isDestroyed() ? pairingWindow : null;
      if (!reusable && pairingWindow && !pairingWindow.isDestroyed()) pairingWindow.destroy();
      const issued = service.issuePairing();
      if (reusable) {
        clearExpiryTimer(); pairingExpiresAt = "";
        await reusable.webContents.executeJavaScript(`document.getElementById("qr").removeAttribute("src");document.getElementById("qr").hidden=true;document.getElementById("pairing-code").value="";document.getElementById("expiry").textContent="";document.getElementById("status").textContent="";`);
      }
      const info = await issued;
      const lifetime = remaining(info.expiresAt);
      if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > PAIRING_LIFETIME_MS) throw new Error("Mobile pairing must expire within two minutes");
      const qr = await QRCode.toDataURL(mobilePairingQrPayload(info), { errorCorrectionLevel: "M", width: 496, margin: 2, color: { dark: "#181818", light: "#ffffff" } });
      if (closed || current !== generation || !isCurrentService(service) || remaining(info.expiresAt) <= 0) return;
      const locale = deps.getLocale(); const icon = appIcon();
      if (reusable) {
        if (pairingWindow !== reusable || reusable.isDestroyed()) return;
        pairingExpiresAt = info.expiresAt;
        await reusable.webContents.executeJavaScript(`(()=>{document.getElementById("origin").textContent=${JSON.stringify(info.origin)};const qr=document.getElementById("qr");qr.src=${JSON.stringify(qr)};qr.hidden=false;document.getElementById("expiry").textContent=${JSON.stringify(countdown(remaining(info.expiresAt)))};const code=document.getElementById("pairing-code");code.value=${JSON.stringify(info.token)};code.type="password";code.onfocus=()=>code.select();const visibility=document.getElementById("code-visibility");visibility.innerHTML=${JSON.stringify(mobileIcon("eye",18))};visibility.setAttribute("aria-label",${JSON.stringify(copy(locale).showCode)});visibility.setAttribute("aria-pressed","false");document.getElementById("status").textContent="";})()`);
        if (closed || current !== generation || pairingWindow !== reusable || reusable.isDestroyed()) return;
        pairingInfo = info;armExpiry(reusable, info, locale); reusable.show(); reusable.focus(); return;
      }
      const window = new BrowserWindow({
        title: copy(locale).title, width: 440, height: 680, minWidth: 360, minHeight: 520,
        show: false, autoHideMenuBar: true, backgroundColor: builtinWindowBackground(nativeTheme.shouldUseDarkColors ? "dark" : "light"),
        ...(icon.path ? { icon: icon.path } : {}),
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false, partition: `pi-mobile-pairing-${randomUUID()}` },
      });
      pairingWindow = window; pairingExpiresAt = info.expiresAt;
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        if (closed || pairingWindow !== window || window.isDestroyed()) return;
        if (url === COPY_CODE_ACTION || url === COPY_LINK_ACTION) {
          const info = pairingInfo;const current = deps.getService()?.getPairing();
          if (!info || remaining(info.expiresAt) <= 0 || current?.token !== info.token || current.expiresAt !== info.expiresAt) return;
          clipboard.writeText(url === COPY_CODE_ACTION ? info.token : mobilePairingQrPayload(info));
          void window.webContents.executeJavaScript(`document.getElementById("status").textContent=${JSON.stringify(url === COPY_CODE_ACTION ? copy(deps.getLocale()).copiedCode : copy(deps.getLocale()).copiedLink)};`);
          return;
        }
        if (url === TOGGLE_CODE_ACTION) {
          const strings = copy(deps.getLocale());
          void window.webContents.executeJavaScript(`(()=>{const code=document.getElementById("pairing-code");const visible=code.type==="password";code.type=visible?"text":"password";const button=document.getElementById("code-visibility");button.innerHTML=visible?${JSON.stringify(mobileIcon("eyeOff",18))}:${JSON.stringify(mobileIcon("eye",18))};button.setAttribute("aria-label",visible?${JSON.stringify(strings.hideCode)}:${JSON.stringify(strings.showCode)});button.setAttribute("aria-pressed",String(visible));})()`);
          return;
        }
        if (url !== NEW_CODE_ACTION) return;
        void showPairing(true).catch(() => {
          if (closed || pairingWindow !== window || window.isDestroyed()) return;
          void window.webContents.executeJavaScript(`document.getElementById("status").textContent=${JSON.stringify(copy(deps.getLocale()).newCodeFailed)};`).catch(() => { if (!window.isDestroyed()) window.destroy(); });
        });
      });
      window.webContents.on("will-attach-webview", event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.on("context-menu", (_event, params) => { if (params.isEditable) Menu.buildFromTemplate([{ role: "copy" }, { role: "selectAll" }]).popup({ window }); });
      window.once("closed", () => {
        if (pairingWindow === window) { pairingWindow = null; pairingInfo = null; pairingExpiresAt = ""; clearExpiryTimer(); }
        abortDialogs();
      });
      try {
        // Credentials are injected into DOM properties, never into the shell URL.
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pairingShell(locale))}`);
        if (closed || current !== generation || window.isDestroyed() || remaining(info.expiresAt) <= 0) { if (!window.isDestroyed()) window.destroy(); return; }
        await window.webContents.executeJavaScript(`(()=>{document.getElementById("origin").textContent=${JSON.stringify(info.origin)};const qr=document.getElementById("qr");qr.src=${JSON.stringify(qr)};qr.hidden=false;document.getElementById("expiry").textContent=${JSON.stringify(countdown(remaining(info.expiresAt)))};const code=document.getElementById("pairing-code");code.value=${JSON.stringify(info.token)};code.type="password";code.onfocus=()=>code.select();const visibility=document.getElementById("code-visibility");visibility.innerHTML=${JSON.stringify(mobileIcon("eye",18))};visibility.setAttribute("aria-label",${JSON.stringify(copy(locale).showCode)});visibility.setAttribute("aria-pressed","false");document.getElementById("status").textContent="";${icon.dataUrl ? `const logo=document.getElementById("brand-icon");logo.src=${JSON.stringify(icon.dataUrl)};logo.hidden=false;` : ""}})()`);
        if (closed || current !== generation || window.isDestroyed()) return;
        pairingInfo = info;armExpiry(window, info, locale); window.show(); window.focus();
      } catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
    })();
    opening = creation;
    void creation.finally(() => { if (opening === creation) opening = null; }).catch(() => {});
    return creation;
  }

  async function revoke(service: MobilePairingUiService, browser: MobilePairedBrowser): Promise<void> {
    const strings = copy(deps.getLocale()); const controller = new AbortController(); dialogs.add(controller); const current = generation;
    const parent = liveParent(); const parentClosed = () => controller.abort(); parent?.once("closed", parentClosed);
    try {
      const result = await message({ type: "warning", title: strings.revokeTitle, message: claim(browser.label, 200), detail: `${strings.created}: ${browser.createdAt}\n${strings.expires}: ${browser.expiresAt}\n\n${strings.revokeDetail}`, buttons: [strings.cancel, strings.revoke], defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal });
      if (result.response !== 1 || controller.signal.aborted || closed || current !== generation || !isCurrentService(service) || (parent && parent.isDestroyed())) return;
      const revoked = service.revokeBrowser(browser.id);
      await message({ type: "info", title: strings.browsers, message: revoked ? strings.revoked : strings.alreadyRevoked, buttons: [strings.ok] });
    } finally { parent?.removeListener("closed", parentClosed); dialogs.delete(controller); }
  }

  async function showSessions(): Promise<void> {
    if (closed) return; const service = deps.getService(); if (!service) { await unavailable(); return; }
    const strings = copy(deps.getLocale()); const browsers = service.listBrowsers();
    if (!browsers.length) { await message({ type: "info", title: strings.browsers, message: strings.none, buttons: [strings.ok] }); return; }
    browserMenu?.closePopup();
    const menu = Menu.buildFromTemplate(browsers.map(browser => ({
      label: claim(browser.label, 120).replace(/&/g, "&&"),
      submenu: [
        { label: `${strings.created}: ${browser.createdAt}`, enabled: false },
        { label: `${strings.expires}: ${browser.expiresAt}`, enabled: false },
        { type: "separator" as const },
        { label: strings.revoke, click: () => { void revoke(service, browser).catch(() => { if (!closed) void unavailable(); }); } },
      ],
    })));
    browserMenu = menu;
    const parent = liveParent();
    await new Promise<void>(resolve => menu.popup({ ...(parent ? { window: parent } : {}), callback: () => { if (browserMenu === menu) browserMenu = null; resolve(); } }));
  }

  function close(): void {
    closed = true; generation++; abortDialogs();pairingInfo = null;
    browserMenu?.closePopup(); browserMenu = null;
    clearExpiryTimer();
    if (pairingWindow && !pairingWindow.isDestroyed()) pairingWindow.destroy(); pairingWindow = null;
  }

  return { confirmPairing, showPairing, showSessions, close };
}
