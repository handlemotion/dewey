import Exa from "exa-js";
import { z } from "zod";
import type { Citation } from "../../shared/contracts";

export const searchWebInputSchema = z.object({
  query: z.string().min(2).max(10_000),
  mode: z.enum(["instant", "balanced", "deep"]).default("balanced"),
  resultCount: z.number().int().min(1).max(10).default(5),
});

export type SearchWebInput = z.infer<typeof searchWebInputSchema>;

export type SearchWebResult = {
  findings?: string;
  citations: Citation[];
  costUsd?: number;
  requestId: string;
};

export class SearchTools {
  private exa: Exa | undefined;

  constructor(apiKey?: string) {
    this.configure(apiKey);
  }

  configure(apiKey?: string): void {
    this.exa = apiKey == null ? undefined : new Exa(apiKey);
  }

  isConfigured(): boolean {
    return this.exa != null;
  }

  async searchWeb(input: SearchWebInput, abortSignal?: AbortSignal): Promise<SearchWebResult> {
    if (this.exa == null) throw new Error("Exa is not configured.");
    abortSignal?.throwIfAborted();
    const parsed = searchWebInputSchema.parse(input);
    const type = parsed.mode === "instant" ? "instant" : parsed.mode === "deep" ? "deep" : "auto";
    const response = await this.exa.search(parsed.query, {
      type,
      numResults: parsed.resultCount,
      contents: {
        highlights: { maxCharacters: 1_500 },
      },
      ...(type === "deep"
        ? {
            outputSchema: {
              type: "text" as const,
              description: "A concise synthesis grounded only in the returned sources.",
            },
          }
        : {}),
    });
    abortSignal?.throwIfAborted();

    const findings =
      typeof response.output?.content === "string" ? response.output.content : undefined;
    return {
      ...(findings == null ? {} : { findings }),
      citations: response.results.map((result) => ({
        id: result.id,
        title: result.title ?? result.url,
        url: result.url,
        ...(result.publishedDate == null ? {} : { publishedAt: result.publishedDate }),
        ...(result.highlights?.[0] == null ? {} : { excerpt: result.highlights[0] }),
        sourceQuality: describeSourceQuality(result.url),
      })),
      ...(response.costDollars?.total == null ? {} : { costUsd: response.costDollars.total }),
      requestId: response.requestId,
    };
  }

  async researchWeb(
    objective: string,
    abortSignal?: AbortSignal,
  ): Promise<{ result: string; citations: Citation[]; costUsd?: number }> {
    if (this.exa == null) throw new Error("Exa is not configured.");
    abortSignal?.throwIfAborted();

    try {
      const created = await this.exa.research.create({
        instructions: z.string().min(2).max(20_000).parse(objective),
        model: "exa-research",
      });
      const finished = await this.exa.research.pollUntilFinished(created.researchId, {
        pollInterval: 2_000,
        timeoutMs: 120_000,
      });
      abortSignal?.throwIfAborted();
      if (finished.status !== "completed") {
        throw new Error(`Exa research ended with status ${finished.status}.`);
      }
      return {
        result: finished.output.content,
        citations: extractResearchCitations(finished.output.content),
        ...(finished.costDollars?.total == null ? {} : { costUsd: finished.costDollars.total }),
      };
    } catch {
      abortSignal?.throwIfAborted();
      const fallback = await this.searchWeb(
        {
          query: objective,
          mode: "deep",
          resultCount: 10,
        },
        abortSignal,
      );
      return {
        result:
          fallback.findings ??
          fallback.citations.map((citation) => `${citation.title}: ${citation.url}`).join("\n"),
        citations: fallback.citations,
        ...(fallback.costUsd == null ? {} : { costUsd: fallback.costUsd }),
      };
    }
  }
}

function describeSourceQuality(url: string): string {
  const hostname = new URL(url).hostname;
  if (
    hostname.endsWith(".gov") ||
    hostname.endsWith(".edu") ||
    hostname === "github.com" ||
    hostname.startsWith("docs.")
  ) {
    return "primary or authoritative";
  }
  return "web source";
}

function extractResearchCitations(text: string): Citation[] {
  const urls = [...new Set(text.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [])];
  return urls.map((url) => ({
    id: crypto.randomUUID(),
    title: new URL(url).hostname,
    url,
    sourceQuality: describeSourceQuality(url),
  }));
}
