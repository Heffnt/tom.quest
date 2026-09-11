import { expect, it } from "vitest";
import { REDACTED_SHAPES } from "../../session-host/redact.mjs";
import { claudeAssistant, claudeAttachment, claudeTaskResultCompleted, claudeTaskResultLaunched, claudeToolResult, claudeUserText, claudeUserTurn, codexMeta, codexResponseItem, codexTaskComplete, codexTokenCount, codexTurnContext, codexUsageRecord, persistedOutput, subagentMeta } from "./fixtures.mjs";
it("fixtures contain no credential-shaped text", () => {
  const body = JSON.stringify([claudeAssistant(), claudeAttachment("environment"), claudeTaskResultCompleted(), claudeTaskResultLaunched(), claudeToolResult(), claudeUserText(), claudeUserTurn(), codexMeta(), codexResponseItem("message"), codexTaskComplete(), codexTokenCount(), codexTurnContext(), codexUsageRecord(), persistedOutput(), subagentMeta()]);
  for (const { pattern } of REDACTED_SHAPES) { pattern.lastIndex = 0; expect(pattern.test(body)).toBe(false); }
});
