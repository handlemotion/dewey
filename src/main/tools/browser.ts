import { Firecrawl } from "firecrawl";
import { z } from "zod";
import type { ConsequentialAction } from "../../shared/contracts";

const browserUrlSchema = z
  .url()
  .max(8_192)
  .refine(isSafeBrowserUrl, "Browser tools accept only HTTP(S) URLs without embedded credentials.");

export const inspectBrowserInputSchema = z.object({
  url: browserUrlSchema,
  objective: z.string().min(2).max(10_000),
  profileName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .optional(),
});

export const browserActionInputSchema = z.object({
  url: browserUrlSchema,
  instruction: z.string().min(2).max(10_000),
  target: z.string().min(1).max(2_000),
  expectedEffect: z.string().min(2).max(10_000),
  risk: z.enum(["write", "financial", "destructive"]),
  costDescription: z.string().min(1).max(2_000).nullable(),
  irreversibility: z.string().min(1).max(2_000).nullable(),
  profileName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .optional(),
});

export type BrowserActionInput = z.infer<typeof browserActionInputSchema>;
export const browserProfileNameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/);

export class BrowserTools {
  private firecrawl: Firecrawl | undefined;

  constructor(apiKey?: string) {
    this.configure(apiKey);
  }

  configure(apiKey?: string): void {
    this.firecrawl = apiKey == null ? undefined : new Firecrawl({ apiKey });
  }

  async beginProfileSession(name: string): Promise<{
    sessionId: string;
    liveViewUrl: string;
  }> {
    if (this.firecrawl == null) throw new Error("Firecrawl is not configured.");
    const profileName = browserProfileNameSchema.parse(name);
    const session = await this.firecrawl.browser({
      ttl: 900,
      activityTtl: 300,
      streamWebView: true,
      profile: { name: profileName, saveChanges: true },
    });
    const sessionId = session.id;
    const liveViewUrl = session.interactiveLiveViewUrl ?? session.liveViewUrl;
    if (!session.success || sessionId == null || liveViewUrl == null) {
      throw new Error(session.error ?? "Firecrawl could not open a visible login session.");
    }
    if (!isHttpsUrl(liveViewUrl)) {
      await this.firecrawl.deleteBrowser(sessionId).catch(() => undefined);
      throw new Error("Firecrawl returned an unsafe browser-session URL.");
    }
    return { sessionId, liveViewUrl };
  }

  async finishProfileSession(sessionId: string): Promise<void> {
    if (this.firecrawl == null) throw new Error("Firecrawl is not configured.");
    const result = await this.firecrawl.deleteBrowser(sessionId);
    if (!result.success) {
      throw new Error(result.error ?? "Firecrawl could not close the browser session.");
    }
  }

  async clearProfile(name: string): Promise<void> {
    if (this.firecrawl == null) throw new Error("Firecrawl is not configured.");
    const profileName = browserProfileNameSchema.parse(name);
    const session = await this.firecrawl.browser({
      ttl: 300,
      activityTtl: 120,
      profile: { name: profileName, saveChanges: true },
    });
    if (!session.success || session.id == null) {
      throw new Error(session.error ?? "Firecrawl could not open the profile for revocation.");
    }
    try {
      const result = await this.firecrawl.browserExecute(session.id, {
        language: "node",
        timeout: 60,
        code: `await page.context().clearCookies();
for (const openPage of page.context().pages()) {
  await openPage.goto("about:blank");
}`,
      });
      if (!result.success || (result.exitCode != null && result.exitCode !== 0)) {
        throw new Error(result.error ?? result.stderr ?? "Profile data could not be cleared.");
      }
    } finally {
      await this.firecrawl.deleteBrowser(session.id).catch(() => undefined);
    }
  }

  async inspect(input: z.infer<typeof inspectBrowserInputSchema>): Promise<{
    url: string;
    title?: string;
    markdown: string;
    profileName?: string;
  }> {
    if (this.firecrawl == null) throw new Error("Firecrawl is not configured.");
    const parsed = inspectBrowserInputSchema.parse(input);
    const document = await this.firecrawl.scrape(parsed.url, {
      formats: ["markdown"],
      onlyMainContent: true,
      lockdown: true,
      ...(parsed.profileName == null
        ? {}
        : { profile: { name: parsed.profileName, saveChanges: false } }),
    });
    return {
      url: document.metadata?.sourceURL ?? parsed.url,
      ...(document.metadata?.title == null ? {} : { title: document.metadata.title }),
      markdown: document.markdown?.slice(0, 40_000) ?? "",
      ...(parsed.profileName == null ? {} : { profileName: parsed.profileName }),
    };
  }

  propose(input: BrowserActionInput, originatingTaskId: string): ConsequentialAction {
    const parsed = browserActionInputSchema.parse(input);
    const risk = inferBrowserRisk(parsed);
    if (risk === "financial" && parsed.costDescription == null) {
      throw new Error("Financial browser actions require a clear cost description.");
    }
    if (risk === "destructive" && parsed.irreversibility == null) {
      throw new Error("Destructive browser actions require an irreversibility description.");
    }
    const createdAt = new Date();
    return {
      id: crypto.randomUUID(),
      tool: "executeApprovedBrowserAction",
      arguments: parsed,
      target: parsed.target,
      expectedEffect: parsed.expectedEffect,
      risk,
      ...(parsed.costDescription == null ? {} : { costDescription: parsed.costDescription }),
      ...(parsed.irreversibility == null ? {} : { irreversibility: parsed.irreversibility }),
      originatingTaskId,
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
      status: "pending",
      createdAt: createdAt.toISOString(),
    };
  }

  async execute(input: BrowserActionInput): Promise<{
    output: unknown;
    profileName?: string;
  }> {
    if (this.firecrawl == null) throw new Error("Firecrawl is not configured.");
    const parsed = browserActionInputSchema.parse(input);
    if (looksLikeSecretEntry(parsed.instruction)) {
      throw new Error("Dewey will not type stored passwords. Complete authentication visibly.");
    }

    const document = await this.firecrawl.scrape(parsed.url, {
      formats: ["markdown"],
      onlyMainContent: true,
      ...(parsed.profileName == null
        ? {}
        : { profile: { name: parsed.profileName, saveChanges: true } }),
    });
    const scrapeId = document.metadata?.scrapeId;
    if (scrapeId == null) throw new Error("Firecrawl did not return an interactive session.");

    try {
      const result = await this.firecrawl.interact(scrapeId, {
        prompt: parsed.instruction,
        timeout: 120,
      });
      return {
        output: result.output,
        ...(parsed.profileName == null ? {} : { profileName: parsed.profileName }),
      };
    } finally {
      await this.firecrawl.stopInteraction(scrapeId).catch(() => undefined);
    }
  }
}

function looksLikeSecretEntry(instruction: string): boolean {
  return /\b(password|passcode|secret|2fa|one[- ]time code|otp)\b/i.test(instruction);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function inferBrowserRisk(input: BrowserActionInput): "write" | "financial" | "destructive" {
  const description = `${input.instruction} ${input.target} ${input.expectedEffect}`;
  if (
    input.risk === "destructive" ||
    /\b(delete|destroy|erase|permanently remove|close (?:the )?account|revoke)\b/i.test(description)
  ) {
    return "destructive";
  }
  if (
    input.risk === "financial" ||
    /\b(buy|purchase|pay|payment|checkout|transfer money|subscribe|place (?:the )?order|donate)\b/i.test(
      description,
    )
  ) {
    return "financial";
  }
  return "write";
}
