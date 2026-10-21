import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("config: empty env reports both keys missing, with settled defaults", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.workLlm.provider, "deepseek");
  assert.equal(cfg.workLlm.model, null);
  assert.equal(cfg.workLlm.apiKey, "missing");
  assert.equal(cfg.decisionModel.provider, "jev");
  assert.equal(cfg.decisionModel.endpoint, "https://api.typesafe.ai/v1/systemone");
  assert.equal(cfg.decisionModel.model, "jev-1.13.0");
  assert.equal(cfg.decisionModel.apiKey, "missing");
  assert.equal(cfg.embeddings.status, "deferred");
  assert.deepEqual(cfg.missingForLiveIngest, ["WORK_LLM_API_KEY", "TYPESAFE_API_KEY"]);
  assert.equal(cfg.readyForLiveIngest, false);
});

test("config: configured keys are reported by status only — values never leak", () => {
  const cfg = loadConfig({
    WORK_LLM_PROVIDER: "deepseek",
    WORK_LLM_API_KEY: "sk-secret-work-value",
    WORK_LLM_MODEL: "deepseek-chat",
    TYPESAFE_API_KEY: "ts-secret-jev-value",
    JEV_MODEL: "jev-1.13.0",
  });
  assert.equal(cfg.workLlm.apiKey, "configured");
  assert.equal(cfg.workLlm.model, "deepseek-chat");
  assert.equal(cfg.decisionModel.apiKey, "configured");
  assert.deepEqual(cfg.missingForLiveIngest, []);
  assert.equal(cfg.readyForLiveIngest, true);
  const printed = JSON.stringify(cfg);
  assert.ok(!printed.includes("sk-secret-work-value"));
  assert.ok(!printed.includes("ts-secret-jev-value"));
});

test("config: blank values count as missing, embedding dimension parses", () => {
  const cfg = loadConfig({
    WORK_LLM_API_KEY: "   ",
    TYPESAFE_API_KEY: "x",
    EMBEDDING_DIMENSION: "768",
  });
  assert.equal(cfg.workLlm.apiKey, "missing");
  assert.deepEqual(cfg.missingForLiveIngest, ["WORK_LLM_API_KEY"]);
  assert.equal(cfg.embeddings.dimension, 768);
});
