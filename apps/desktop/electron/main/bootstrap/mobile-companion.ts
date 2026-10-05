import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHost } from "@pi-desktop/agent-host";
import type { HostRpc } from "@pi-desktop/host-runtime";
import { IPC, type PromptEnhancementResponse } from "@pi-desktop/shared";
import { startMobileCompanion } from "../mobile/readonly-server";
import { createOperations as createMobileBackendOperations } from "../mobile/backend-operations";
import { createMobileUploadStore, type MobileUploadStore } from "../mobile/uploads";
import { createMobileDiffAccess } from "../mobile/diff-access";
import { loadMobileModels } from "../mobile/model-catalog";
import { createMobileSessionData } from "../mobile/session-data";
import { MOBILE_PAIRING_LIFETIME, type MobilePairingDecision, type MobilePairingRequest } from "../mobile/browser-auth";
import { createMobileBrowserAuthorizationStore } from "../mobile/browser-authorization-store";
import { createMobileNativeUiOperations } from "../mobile/native-ui-operations";
import type { BrowserAssets } from "../mobile/browser-assets";
import { getRegisteredComposerCommandService } from "../ipc/composer-ipc";
import type { BrowserWindow } from "electron";
import type { createMobilePairingUi } from "../mobile/pairing-ui";

type Options = {
  agentHost: AgentHost;
  getHost: () => HostRpc | null;
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  isSessionBusy: (sessionId: string) => boolean;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  getMainWindow?: () => BrowserWindow | null;
  getLocale?: () => string;
  loadBrowserAssets?: () => Promise<BrowserAssets>;
  /** Trusted test boundary; production always uses the native confirmation UI. */
  confirmPairing?: (request: MobilePairingRequest) => Promise<MobilePairingDecision>;
};

/** No environment opt-in means no listener and no setup-file writes. */
export function createMobileCompanionBoot(options: Options) {
  const env = options.env ?? process.env;
  let closed = false;
  let opening: Promise<void> | undefined;
  let listener: Awaited<ReturnType<typeof startMobileCompanion>> | undefined;
  let uploads: MobileUploadStore | undefined;
  let setupText: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pairingUi: ReturnType<typeof createMobilePairingUi> | undefined;
  const setupPath = join(options.dataDir, "mobile-pairing.json");
  const browserAuthorizationStore = createMobileBrowserAuthorizationStore(options.dataDir, options.log);
  const removeSetup = async () => {
    try {
      // Never remove a file written by a newer service instance.
      if (setupText && await readFile(setupPath, "utf8") === setupText) await unlink(setupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.log("mobile setup-file cleanup failed");
    }
  };
  const writeSetup = async (value: {origin:string;token:string;expiresAt:string}) => {
    clearTimeout(timer);
    setupText = JSON.stringify({origin:value.origin,access:"controller",pairingCode:value.token,expiresAt:value.expiresAt},null,2)+"\n";
    await mkdir(options.dataDir,{recursive:true});
    await writeFile(setupPath,setupText,{mode:0o600});
    timer = setTimeout(() => {void removeSetup();},MOBILE_PAIRING_LIFETIME);timer.unref();
  };
  return {
    enabled:Boolean(env.PI_DESKTOP_MOBILE_ORIGIN),
    async showPairing() {await opening;await pairingUi?.showPairing();},
    async showSessions() {await opening;await pairingUi?.showSessions();},
    open(): Promise<void> {
      if (opening) return opening;
      opening = (async () => {
        if (closed || !env.PI_DESKTOP_MOBILE_ORIGIN) return;
        const port = Number(env.PI_DESKTOP_MOBILE_PORT ?? "4818");
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid mobile port");
        const configuredOrigin = env.PI_DESKTOP_MOBILE_ORIGIN;
        const originUrl = new URL(configuredOrigin);
        // An Android emulator can use an existing same-port ADB reverse without
        // tailnet DNS. Only this exact loopback origin gets the server's local
        // development path; every external origin still requires HTTPS.
        const loopbackTest = configuredOrigin === `http://127.0.0.1:${port}` && originUrl.origin === configuredOrigin;
        if (!loopbackTest && originUrl.protocol !== "https:") throw new Error("mobile origin requires HTTPS or the exact loopback test origin");
        if (!options.confirmPairing) {
          const {createMobilePairingUi} = await import("../mobile/pairing-ui");
          pairingUi = createMobilePairingUi({getService:() => listener && ({getPairing:listener.getPairing,issuePairing:async () => {const value = listener!.issuePairing();await writeSetup(value);return value;},listBrowsers:listener.listBrowsers,revokeBrowser:listener.revokeBrowser}),getMainWindow:options.getMainWindow ?? (() => null),getLocale:options.getLocale ?? (() => "en")});
        }
        uploads = createMobileUploadStore(options.dataDir);
        const operations = createMobileBackendOperations({
          getHost: options.getHost, isSessionBusy: options.isSessionBusy,
          compact: async (sessionId) => {
            const result = await options.invoke(IPC.invoke.agentCompact, [{ sessionId }]);
            return { accepted: !(result && typeof result === "object" && "accepted" in result && result.accepted === false) };
          },
          deleteSession: async (sessionId) => { await options.invoke(IPC.invoke.sessionDelete, [sessionId]); },
          resolveAttachments: uploads.resolve,
        });
        const nativeUiOperations = createMobileNativeUiOperations({
          getHost: options.getHost,
          invoke: options.invoke,
          agentHost: options.agentHost,
          isSessionBusy: options.isSessionBusy,
          dataDir: options.dataDir,
          uploadStore: uploads,
          getComposerCommands: root => getRegisteredComposerCommandService().buildComposerCommands(root),
        });
        try {
          listener = await startMobileCompanion({
            agentHost: options.agentHost,
            ...(loopbackTest ? {} : { publicOrigin: configuredOrigin }),
            port,
            listSessions: operations.sessions.list,
            operations, uploadStore: uploads,
            nativeUiOperations,
            browserAssets: await options.loadBrowserAssets?.(),
            getModels: () => loadMobileModels(options.invoke),
            diffAccess: createMobileDiffAccess(options.getHost),
            sessionData: createMobileSessionData(options.getHost, options.dataDir),
            browserAuthorizationStore,
            enhancePrompt: async request => await options.invoke(IPC.invoke.promptEnhance, [request]) as PromptEnhancementResponse,
            log: options.log,
            confirmPairing:async request => {await removeSetup();return options.confirmPairing ? options.confirmPairing(request) : pairingUi!.confirmPairing(request);},
          });
          if (closed) { await listener.close(); return; }
          await writeSetup(listener.pairing);
          if (closed) { await listener.close(); await removeSetup(); return; }
          options.log(`mobile companion available at ${listener.origin}; pairing file: ${setupPath}`);
          // This is an explicit mobile opt-in. Put bootstrap information on the
          // trusted desktop; ordinary/default-off startup never creates this UI.
          await pairingUi?.showPairing().catch(() => options.log("mobile pairing UI failed"));
        } catch (error) {
          await listener?.close(); await uploads.close(); await removeSetup(); throw error;
        }
      })();
      return opening;
    },
    async close() {
      closed = true;
      await opening?.catch(() => {});
      clearTimeout(timer);
      pairingUi?.close();
      await listener?.close();
      await uploads?.close();
      await removeSetup();
    },
  };
}

let active: ReturnType<typeof createMobileCompanionBoot> | null = null;
export const getActiveMobileCompanion = () => active;
export function setActiveMobileCompanion(value: typeof active): void { active = value; }
