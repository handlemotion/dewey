import { tool } from "ai";
import { z } from "zod";
import { browserActionInputSchema, inspectBrowserInputSchema } from "./browser";
import { searchWebInputSchema } from "./search";

export const taskProposalInputSchema = z.object({
  objective: z.string().min(2).max(20_000),
  reasonForDelegation: z.string().min(2).max(10_000),
  expectedOutput: z.string().min(2).max(10_000),
  reasoningLevel: z.enum(["focused", "deep", "maximum"]).default("deep"),
  explicitUserRequest: z
    .boolean()
    .default(false)
    .describe("True only when the user explicitly asked for Malcolm by name."),
});

export const realtimeTools = {
  searchWeb: tool({
    description:
      "Search the live web for a fast grounded answer. Returns focused findings and source citations.",
    inputSchema: searchWebInputSchema,
  }),
  inspectBrowser: tool({
    description:
      "Read and inspect an interactive web page without submitting forms or changing external state.",
    inputSchema: inspectBrowserInputSchema,
  }),
  proposeBrowserAction: tool({
    description:
      "Propose a consequential browser action. Classify it as write, financial, or destructive; financial actions require a clear cost description and destructive actions require an irreversibility description. This never performs the action.",
    inputSchema: browserActionInputSchema,
  }),
  proposeMalcolm: tool({
    description:
      "Propose delegating substantial context-heavy work to Malcolm. Use only when structural delegation criteria apply.",
    inputSchema: taskProposalInputSchema,
  }),
};

type AvailableRealtimeTools = Partial<Omit<typeof realtimeTools, "proposeMalcolm">> &
  Pick<typeof realtimeTools, "proposeMalcolm">;

export function availableRealtimeTools(input: {
  exaConfigured: boolean;
  firecrawlConfigured: boolean;
}): AvailableRealtimeTools {
  const enabled: Partial<typeof realtimeTools> = {};
  if (input.exaConfigured) enabled.searchWeb = realtimeTools.searchWeb;
  if (input.firecrawlConfigured) {
    enabled.inspectBrowser = realtimeTools.inspectBrowser;
    enabled.proposeBrowserAction = realtimeTools.proposeBrowserAction;
  }
  enabled.proposeMalcolm = realtimeTools.proposeMalcolm;
  return enabled as AvailableRealtimeTools;
}
