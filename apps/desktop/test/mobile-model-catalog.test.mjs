import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { loadMobileModels } = await import("../electron/main/mobile/model-catalog.ts");

test("mobile models use cached desktop metadata and whitelist public fields", async () => {
  const calls = [];
  const models = await loadMobileModels(async (channel, args) => {
    calls.push({ channel, args });
    if (channel === IPC.invoke.providersList) return { providers: [{ id: "enabled", name: "Local account", apiKey: "private-provider-secret", headers: { Authorization: "private-header" } }, { id: "disabled", enabled: false }] };
    assert.equal(channel, IPC.invoke.providersListModels);
    assert.deepEqual(args, [{ providerId: "enabled", source: "cache" }]);
    return { models: [{ modelId: "model", displayName: "Model name", contextWindow:200000, supportedThinkingLevels: ["low", "high", "invalid", "low"], capabilities: ["vision"], provider: { secret: "private-model-data" } }] };
  });
  assert.deepEqual(models, [{ providerId: "enabled", providerName: "Local account", id: "model", name: "Model name", thinkingLevels: ["omit", "low", "high"], vision: true, contextWindow:200000 }]);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(models).includes("private"));
});

test("unknown metadata never invents reasoning capabilities", async () => {
  const models = await loadMobileModels(async channel => channel === IPC.invoke.providersList ? { providers: [{ id: "account" }, null] } : { models: [{ modelId: "plain" }, { modelId: null }, null] });
  assert.deepEqual(models[0].thinkingLevels, ["omit"]);
  assert.equal(models[0].vision, false);
  assert.equal(models.length, 1);
  assert.equal(models[0].contextWindow,128000);
});

test("mobile context capacity uses desktop binding provenance", async () => {
  const models = await loadMobileModels(async channel => channel === IPC.invoke.providersList
    ? { providers:[{id:"provider",models:[{id:"manual",contextWindow:64000,contextWindowSource:"user"},{id:"catalog",contextWindow:64000,contextWindowSource:"catalog"}]}] }
    : {models:[{modelId:"manual",contextWindow:200000},{modelId:"catalog",contextWindow:200000}]});
  assert.equal(models[0].contextWindow,64000);
  assert.equal(models[1].contextWindow,200000);
});
