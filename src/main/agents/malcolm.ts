import { createOpenAI, type OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import { isStepCount, Output, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import type { Citation, MalcolmTask, ProposedAction, ReasoningLevel } from "../../shared/contracts";
import { MODELS, REASONING_EFFORT } from "../../shared/models";
import { createLocalFileReader, readLocalFileInputSchema } from "../tools/local-files";
import { type SearchTools, searchWebInputSchema } from "../tools/search";
import { MALCOLM_INSTRUCTIONS } from "./prompts";

const proposedActionSchema = z.object({
  tool: z.string().min(1).max(256),
  rationale: z.string().min(1).max(10_000),
  arguments: z
    .string()
    .max(50_000)
    .refine(isJsonString, "Proposed action arguments must be valid JSON.")
    .describe("A valid JSON string containing the exact proposed tool arguments."),
  expectedEffect: z.string().min(1).max(10_000),
  estimatedCost: z.string().max(256).nullable(),
  risk: z.enum(["read", "draft", "write", "financial", "destructive"]),
});

export const malcolmOutputSchema = z.object({
  result: z.string().min(1).max(100_000),
  proposedActions: z.array(proposedActionSchema).max(20),
});

export const MALCOLM_EXECUTION_LIMITS = {
  focused: {
    maxSteps: 8,
    maxOutputTokens: 4_000,
    totalMs: 6 * 60_000,
    stepMs: 90_000,
    toolMs: 60_000,
    researchWebMs: 4 * 60_000,
  },
  deep: {
    maxSteps: 14,
    maxOutputTokens: 8_000,
    totalMs: 15 * 60_000,
    stepMs: 3 * 60_000,
    toolMs: 90_000,
    researchWebMs: 6 * 60_000,
  },
  maximum: {
    maxSteps: 20,
    maxOutputTokens: 12_000,
    totalMs: 30 * 60_000,
    stepMs: 5 * 60_000,
    toolMs: 2 * 60_000,
    researchWebMs: 10 * 60_000,
  },
} as const satisfies Record<
  ReasoningLevel,
  {
    maxSteps: number;
    maxOutputTokens: number;
    totalMs: number;
    stepMs: number;
    toolMs: number;
    researchWebMs: number;
  }
>;

export type MalcolmRunResult = {
  result: string;
  proposedActions: ProposedAction[];
  citations: Citation[];
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export class MalcolmService {
  private readonly search: SearchTools;
  private readonly readLocalFile: ReturnType<typeof createLocalFileReader>;

  constructor(
    search: SearchTools,
    private readonly getWorkspaceRoot: () => string | undefined,
    private readonly getOpenAIKey: () => string | undefined,
  ) {
    this.search = search;
    this.readLocalFile = createLocalFileReader(getWorkspaceRoot);
  }

  async run(
    task: MalcolmTask,
    relevantContext: string,
    abortSignal: AbortSignal,
    onProgress: (progress: string) => void,
  ): Promise<MalcolmRunResult> {
    const apiKey = this.getOpenAIKey();
    if (apiKey == null) throw new Error("OpenAI is not configured.");
    const citations: Citation[] = [];
    const openai = createOpenAI({ apiKey });
    const limits = MALCOLM_EXECUTION_LIMITS[task.reasoningLevel];
    const tools = {
      ...(this.search.isConfigured()
        ? {
            searchWeb: tool({
              description: "Search the web and return focused findings with source provenance.",
              inputSchema: searchWebInputSchema,
              execute: async (input, { abortSignal: toolAbortSignal }) => {
                const result = await this.search.searchWeb(input, toolAbortSignal);
                collectCitations(citations, result.citations);
                return result;
              },
            }),
            researchWeb: tool({
              description:
                "Run broader Exa research for multi-source synthesis. Use only when a direct deep search is insufficient.",
              inputSchema: z.object({ objective: z.string().min(2) }),
              execute: async ({ objective }, { abortSignal: toolAbortSignal }) => {
                const result = await this.search.researchWeb(objective, toolAbortSignal);
                collectCitations(citations, result.citations);
                return result;
              },
            }),
          }
        : {}),
      ...(this.getWorkspaceRoot() == null
        ? {}
        : {
            readLocalFile: tool({
              description:
                "Read a bounded text or source file inside the selected workspace. Cannot write files or escape the workspace.",
              inputSchema: readLocalFileInputSchema,
              execute: this.readLocalFile,
            }),
          }),
    };
    const agent = new ToolLoopAgent({
      id: "malcolm",
      model: openai.responses(MODELS.malcolm),
      instructions: MALCOLM_INSTRUCTIONS,
      maxOutputTokens: limits.maxOutputTokens,
      maxRetries: 2,
      stopWhen: isStepCount(limits.maxSteps),
      providerOptions: {
        openai: {
          reasoningEffort: REASONING_EFFORT[task.reasoningLevel],
          store: false,
        } satisfies OpenAILanguageModelResponsesOptions,
      },
      tools,
      output: Output.object({ schema: malcolmOutputSchema }),
      onStepStart: ({ stepNumber }) => {
        onProgress(
          stepNumber === 0 ? "Reviewing the objective" : "Following the strongest evidence",
        );
      },
      onToolExecutionStart: ({ toolCall }) => {
        const toolName = toolCall.toolName;
        const label =
          toolName === "searchWeb"
            ? "Searching focused sources"
            : toolName === "researchWeb"
              ? "Running broader research"
              : "Reading selected files";
        onProgress(label);
      },
    });

    const response = await agent.generate({
      prompt: buildPrompt(task, relevantContext),
      abortSignal,
      timeout: {
        totalMs: limits.totalMs,
        stepMs: limits.stepMs,
        toolMs: limits.toolMs,
        tools: {
          researchWebMs: limits.researchWebMs,
        },
      },
    });
    const output = response.output;
    if (output == null) throw new Error("Malcolm returned no structured result.");
    return {
      result: output.result,
      citations,
      proposedActions: output.proposedActions.map((action) => ({
        tool: action.tool,
        rationale: action.rationale,
        arguments: parseJsonArguments(action.arguments),
        expectedEffect: action.expectedEffect,
        ...(action.estimatedCost == null ? {} : { estimatedCost: action.estimatedCost }),
        risk: action.risk,
      })),
      inputTokens: response.totalUsage.inputTokens ?? 0,
      cachedInputTokens: response.totalUsage.inputTokenDetails.cacheReadTokens ?? 0,
      cacheWriteInputTokens: response.totalUsage.inputTokenDetails.cacheWriteTokens ?? 0,
      outputTokens: response.totalUsage.outputTokens ?? 0,
      reasoningTokens: response.totalUsage.outputTokenDetails.reasoningTokens ?? 0,
    };
  }
}

function parseJsonArguments(value: string): unknown {
  return JSON.parse(value);
}

function isJsonString(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function collectCitations(target: Citation[], incoming: Citation[]): void {
  const seen = new Set(target.map((citation) => citation.url));
  for (const citation of incoming) {
    if (seen.has(citation.url) || target.length >= 50) continue;
    target.push(citation);
    seen.add(citation.url);
  }
}

function buildPrompt(task: MalcolmTask, relevantContext: string): string {
  return `Objective:
${task.objective}

Reason for delegation:
${task.reasonForDelegation}

Expected output:
${task.expectedOutput}

Selected relevant context:
${relevantContext || "No additional conversation context was selected."}

Return the requested result and any consequential actions only as structured proposals.
Encode every proposed action's exact arguments as a valid JSON string.`;
}
