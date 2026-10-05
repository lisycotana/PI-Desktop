import {
  bareToolName, compact, delegationLifecycleKind, formatToolValue,
  getToolAction, getToolDisplayName, getToolSummary, getToolSummaryKey,
  getToolSummaryValue, isDelegationStartTool, summaryText, toolSummaryKeys,
} from "../../../src/lib/tool-display";

/** Desktop's actual pure ToolRow presentation rules, without React. */
export const mobileToolDisplayScript = `const SUMMARY_KEYS = ${JSON.stringify(toolSummaryKeys)};\n` + [
  bareToolName, compact, summaryText, formatToolValue, isDelegationStartTool,
  delegationLifecycleKind, getToolAction, getToolDisplayName, getToolSummaryKey,
  getToolSummaryValue, getToolSummary,
].map(fn => fn.toString()).join("\n");
