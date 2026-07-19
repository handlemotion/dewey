import type {
  ActionApprovalInput,
  AppSettings,
  MalcolmTask,
  TaskProposalInput,
  ToolRisk,
} from "./contracts";
import { MODEL_PRICING_USD_PER_MILLION, MODELS } from "./models";

export const TOOL_RISK = {
  searchWeb: "read",
  researchWeb: "read",
  inspectBrowser: "read",
  readLocalFile: "read",
  proposeMalcolm: "draft",
  proposeBrowserAction: "draft",
  executeApprovedBrowserAction: "write",
} as const satisfies Record<string, ToolRisk>;

export const DEFAULT_SETTINGS: AppSettings = {
  handsFree: false,
  inputDeviceId: "default",
  outputDeviceId: "default",
  malcolmDelegationMode: "always-ask",
  malcolmCostThresholdUsd: 0.25,
  malcolmAutomaticCeilingUsd: 1,
  defaultReasoningLevel: "deep",
  workspaceRoot: null,
  openaiConfigured: false,
  exaConfigured: false,
  firecrawlConfigured: false,
};

export function requiresApproval(risk: ToolRisk): boolean {
  return risk === "write" || risk === "financial" || risk === "destructive";
}

export function shouldAskForMalcolm(
  settings: AppSettings,
  estimatedCostUsd: number | undefined,
): boolean {
  switch (settings.malcolmDelegationMode) {
    case "always-ask":
      return true;
    case "never":
      return false;
    case "ask-above-threshold":
      return estimatedCostUsd == null || estimatedCostUsd > settings.malcolmCostThresholdUsd;
    case "automatic-within-limits":
      return estimatedCostUsd == null || estimatedCostUsd > settings.malcolmAutomaticCeilingUsd;
  }
}

export function initialMalcolmStatus(
  settings: AppSettings,
  estimatedCostUsd: number | undefined,
  explicitUserRequest: boolean,
): MalcolmTask["status"] {
  if (explicitUserRequest) return "running";
  if (settings.malcolmDelegationMode === "never") return "cancelled";
  return shouldAskForMalcolm(settings, estimatedCostUsd) ? "awaiting-approval" : "running";
}

export function estimateMalcolmCost(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  cacheWriteInputTokens = 0,
): number {
  const pricing = MODEL_PRICING_USD_PER_MILLION[MODELS.malcolm];
  const cached = Math.min(Math.max(0, cachedInputTokens), Math.max(0, inputTokens));
  const cacheWrite = Math.min(
    Math.max(0, cacheWriteInputTokens),
    Math.max(0, inputTokens - cached),
  );
  const uncached = Math.max(0, inputTokens - cached - cacheWrite);
  return (
    (uncached * pricing.input +
      cached * pricing.cachedInput +
      cacheWrite * pricing.cacheWrite +
      Math.max(0, outputTokens) * pricing.output) /
    1_000_000
  );
}

export function createTaskProposal(
  input: TaskProposalInput,
  now = new Date(),
  id: string = crypto.randomUUID(),
): MalcolmTask {
  const timestamp = now.toISOString();
  return {
    id,
    objective: input.objective.trim(),
    reasonForDelegation: input.reasonForDelegation.trim(),
    expectedOutput: input.expectedOutput.trim(),
    status: "awaiting-approval",
    reasoningLevel: input.reasoningLevel ?? "deep",
    model: MODELS.malcolm,
    estimatedCost: estimateProposalRange(input),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function estimateProposalRange(input: TaskProposalInput): number {
  const characters =
    input.objective.length + input.reasonForDelegation.length + input.expectedOutput.length;
  const estimatedInput = Math.max(2_000, Math.ceil(characters / 4) + 8_000);
  const estimatedOutput = input.reasoningLevel === "maximum" ? 8_000 : 4_000;
  return Number(estimateMalcolmCost(estimatedInput, estimatedOutput).toFixed(2));
}

export function approvalMatches(
  stored: Pick<ActionApprovalInput, "tool" | "arguments">,
  submitted: Pick<ActionApprovalInput, "tool" | "arguments">,
): boolean {
  return (
    stored.tool === submitted.tool &&
    stableJson(stored.arguments) === stableJson(submitted.arguments)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
