import assert from "node:assert/strict";
import test from "node:test";
import { resolvePiModel } from "../dist/llm/model-resolver.js";

test("custom model aliases keep pi transport metadata but send the custom wire id", () => {
  const base = resolvePiModel("openai-codex", "gpt-5.6-sol");
  assert.ok(base, "the pinned pi catalog must retain the compatibility base");

  const alias = resolvePiModel("openai-codex", "gpt-daybreak-blue-latest", [
    { provider: "openai-codex", model: "gpt-daybreak-blue-latest", baseModel: "gpt-5.6-sol" },
  ]);
  assert.ok(alias);
  assert.equal(alias.id, "gpt-daybreak-blue-latest");
  assert.equal(alias.provider, base.provider);
  assert.equal(alias.api, base.api);
  assert.equal(alias.baseUrl, base.baseUrl);
  assert.equal(alias.contextWindow, base.contextWindow);
  assert.deepEqual(alias.thinkingLevelMap, base.thinkingLevelMap);
});

test("custom model aliases fail closed when their compatibility base is unknown", () => {
  assert.equal(resolvePiModel("openai-codex", "private-model", [
    { provider: "openai-codex", model: "private-model", baseModel: "missing-base" },
  ]), undefined);
});

for (const provider of ["openai", "openai-codex"]) {
  for (const modelId of ["gpt-6-sol", "gpt-6-luna"]) {
    test(`${modelId} resolves natively for ${provider}`, () => {
      const model = resolvePiModel(provider, modelId);
      assert.ok(model);
      assert.equal(model.id, modelId);
      assert.equal(model.provider, provider);
      assert.equal(model.api, provider === "openai" ? "openai-responses" : "openai-codex-responses");
      assert.equal(model.reasoning, true);
    });
  }

  test(`Astra resolves natively with the correct transport for ${provider}`, () => {
    const model = resolvePiModel(provider, "gpt-6-astra");
    assert.ok(model);
    assert.equal(model.id, "gpt-6-astra");
    assert.equal(model.provider, provider);
    assert.equal(model.api, provider === "openai" ? "openai-responses" : "openai-codex-responses");
    assert.equal(model.reasoning, true);
    assert.equal(model.thinkingLevelMap.xhigh, "xhigh");
    assert.notEqual(model.thinkingLevelMap.off, "none");
    assert.equal(model.cost.input, 10);
    assert.equal(model.cost.output, 50);
  });
}
