import { IPC, SESSION_THINKING_LEVELS } from "@pi-desktop/shared";
import type { ModelInfo, ProviderPublic } from "@pi-desktop/shared";
import { resolveContextWindow } from "../../../src/lib/context-usage";

export type MobileModel = {
  providerId: string;
  providerName: string;
  id: string;
  name: string;
  thinkingLevels: string[];
  vision: boolean;
  contextWindow: number;
};
type Invoke = (channel: string, args: readonly unknown[]) => Promise<unknown>;
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function rows(value: unknown, key: string): unknown[] {
  const result = object(value)?.[key];
  return Array.isArray(result) ? result : [];
}

/** Read the desktop's local catalog; expose no provider configuration or secrets. */
export async function loadMobileModels(invoke: Invoke): Promise<MobileModel[]> {
  const providers = rows(await invoke(IPC.invoke.providersList, []), "providers");
  const result: MobileModel[] = [];
  for (const entry of providers) {
    const provider = object(entry);
    if (!provider || typeof provider.id !== "string" || provider.enabled === false) continue;
    const providerId = provider.id;
    const models = rows(await invoke(IPC.invoke.providersListModels, [{ providerId, source: "cache" }]), "models");
    for (const entry of models) {
      const model = object(entry);
      const id = model?.modelId ?? model?.id;
      if (!model || typeof id !== "string" || !id) continue;
      const levels = Array.isArray(model.supportedThinkingLevels) ? model.supportedThinkingLevels : [];
      const supported = levels.filter((level): level is string => typeof level === "string" && SESSION_THINKING_LEVELS.some(value => value === level));
      result.push({
        providerId, providerName: typeof provider.name === "string" ? provider.name : providerId,
        id, name: typeof model.displayName === "string" ? model.displayName : typeof model.name === "string" ? model.name : id,
        thinkingLevels: [...new Set(["omit", ...supported])],
        vision: Array.isArray(model.capabilities) && model.capabilities.includes("vision"),
        contextWindow: resolveContextWindow(providerId, id, { [providerId]: models as ModelInfo[] }, [provider as unknown as ProviderPublic]),
      });
    }
  }
  return result;
}
