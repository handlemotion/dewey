import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { app, type IpcMainInvokeEvent, ipcMain } from "electron";
import { z } from "zod";
import type { AppSettings, ConversationMessage, TaskProposalInput } from "../shared/contracts";
import type { AppController } from "./controller";
import { credentialProviderSchema } from "./credentials";
import { SlidingWindowRateLimiter } from "./security/rate-limiter";
import { isTrustedRendererUrl } from "./security/trusted-renderer";

const idSchema = z.uuid();
const citationSchema = z.strictObject({
  id: z.string().min(1).max(256),
  title: z.string().trim().min(1).max(2_000),
  url: z.url().max(8_192),
  publishedAt: z.string().max(128).optional(),
  excerpt: z.string().max(10_000).optional(),
  sourceQuality: z.string().max(512).optional(),
});

const messageSchema = z.strictObject({
  id: idSchema,
  role: z.enum(["user", "dewey"]),
  text: z.string().trim().min(1).max(100_000),
  createdAt: z.iso.datetime(),
  isPartial: z.boolean().optional(),
  citations: z.array(citationSchema).max(20).optional(),
});

const taskProposalSchema = z.strictObject({
  objective: z.string().trim().min(2).max(20_000),
  reasonForDelegation: z.string().trim().min(2).max(10_000),
  expectedOutput: z.string().trim().min(2).max(10_000),
  reasoningLevel: z.enum(["focused", "deep", "maximum"]).optional(),
  explicitUserRequest: z.boolean().optional(),
});

const malcolmDecisionSchema = z.strictObject({
  taskId: idSchema,
  decision: z.enum(["approve", "deny"]),
  editedObjective: z.string().trim().min(2).max(20_000).optional(),
});

const actionDecisionSchema = z.strictObject({
  approvalId: idSchema,
  tool: z.string().min(1).max(256),
  arguments: z.unknown(),
  decision: z.enum(["approve", "deny"]),
});

const settingsPatchSchema = z
  .strictObject({
    handsFree: z.boolean(),
    inputDeviceId: z.string().max(1_024),
    outputDeviceId: z.string().max(1_024),
    malcolmDelegationMode: z.enum([
      "always-ask",
      "ask-above-threshold",
      "automatic-within-limits",
      "never",
    ]),
    malcolmCostThresholdUsd: z.number().finite().min(0).max(100),
    malcolmAutomaticCeilingUsd: z.number().finite().min(0).max(100),
    defaultReasoningLevel: z.enum(["focused", "deep", "maximum"]),
  })
  .partial();

const memoryShape = {
  kind: z.enum(["fact", "preference", "relationship", "routine", "decision"]),
  content: z.string().trim().min(1).max(20_000),
  sensitive: z.boolean(),
  approved: z.boolean(),
};
const memoryBaseSchema = z.strictObject(memoryShape);
const memoryUpdateSchema = z.strictObject({ ...memoryShape, id: idSchema });

const configureProviderSchema = z.strictObject({
  provider: credentialProviderSchema,
  apiKey: z.string().trim().min(8).max(4_096),
});
const browserProfileNameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/);

const realtimeUsageSchema = z.strictObject({
  model: z.string().min(1).max(256),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  audioInputTokens: z.number().int().min(0),
  audioOutputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  estimatedCostUsd: z.number().finite().min(0).max(10_000),
});

const limits: Record<string, { count: number; windowMs: number }> = {
  "dewey:create-realtime-session": { count: 10, windowMs: 60_000 },
  "dewey:execute-realtime-tool": { count: 120, windowMs: 10 * 60_000 },
  "dewey:propose-malcolm": { count: 20, windowMs: 60 * 60_000 },
  "dewey:decide-action": { count: 30, windowMs: 10 * 60_000 },
  "dewey:configure-provider": { count: 10, windowMs: 60 * 60_000 },
  "dewey:begin-browser-profile": { count: 5, windowMs: 60 * 60_000 },
  "dewey:revoke-browser-profile": { count: 10, windowMs: 60 * 60_000 },
};

export function registerIpc(controller: AppController): void {
  const limiter = new SlidingWindowRateLimiter();

  handle("dewey:bootstrap", () => controller.bootstrap(), limiter);
  handle("dewey:create-realtime-session", () => controller.createRealtimeSession(), limiter);
  handle(
    "dewey:execute-realtime-tool",
    (_event, input) => controller.executeRealtimeTool(input),
    limiter,
  );
  handle(
    "dewey:record-message",
    (_event, input) => controller.recordMessage(messageSchema.parse(input) as ConversationMessage),
    limiter,
  );
  handle(
    "dewey:record-realtime-usage",
    (_event, input) => controller.recordRealtimeUsage(realtimeUsageSchema.parse(input)),
    limiter,
  );
  handle(
    "dewey:propose-malcolm",
    (_event, input) =>
      controller.proposeMalcolm(taskProposalSchema.parse(input) as TaskProposalInput),
    limiter,
  );
  handle(
    "dewey:decide-malcolm",
    (_event, input) =>
      controller.decideMalcolm(
        malcolmDecisionSchema.parse(input) as Parameters<AppController["decideMalcolm"]>[0],
      ),
    limiter,
  );
  handle(
    "dewey:cancel-malcolm",
    (_event, taskId) => controller.cancelMalcolm(idSchema.parse(taskId)),
    limiter,
  );
  handle(
    "dewey:decide-action",
    (_event, input) => controller.decideAction(actionDecisionSchema.parse(input)),
    limiter,
  );
  handle(
    "dewey:update-settings",
    (_event, patch) =>
      controller.updateSettings(settingsPatchSchema.parse(patch) as Partial<AppSettings>),
    limiter,
  );
  handle("dewey:select-workspace", () => controller.selectWorkspace(), limiter);
  handle(
    "dewey:configure-provider",
    (_event, input) => {
      const parsed = configureProviderSchema.parse(input);
      return controller.configureProvider(parsed.provider, parsed.apiKey);
    },
    limiter,
  );
  handle(
    "dewey:clear-provider",
    (_event, provider) => controller.clearProvider(credentialProviderSchema.parse(provider)),
    limiter,
  );
  handle(
    "dewey:begin-browser-profile",
    (_event, name) => controller.beginBrowserProfile(browserProfileNameSchema.parse(name)),
    limiter,
  );
  handle(
    "dewey:finish-browser-profile",
    (_event, name) => controller.finishBrowserProfile(browserProfileNameSchema.parse(name)),
    limiter,
  );
  handle(
    "dewey:revoke-browser-profile",
    (_event, name) => controller.revokeBrowserProfile(browserProfileNameSchema.parse(name)),
    limiter,
  );
  handle(
    "dewey:save-memory",
    (_event, input) => controller.saveMemory(memoryBaseSchema.parse(input)),
    limiter,
  );
  handle(
    "dewey:update-memory",
    (_event, input) => controller.updateMemory(memoryUpdateSchema.parse(input)),
    limiter,
  );
  handle(
    "dewey:delete-memory",
    (_event, id) => controller.deleteMemory(idSchema.parse(id)),
    limiter,
  );
}

function handle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, input?: unknown) => unknown,
  limiter: SlidingWindowRateLimiter,
): void {
  ipcMain.handle(channel, async (event, input) => {
    assertTrustedSender(event);
    assertPayloadSize(input);
    const limit = limits[channel];
    if (limit != null) {
      limiter.consume(channel, limit.count, limit.windowMs);
    }
    try {
      return await handler(event, input);
    } catch (error) {
      throw new Error(safeErrorMessage(error));
    }
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (frame == null || frame !== event.sender.mainFrame) {
    throw new Error("IPC is available only to the main Dewey renderer.");
  }
  const url = frame.url;
  const expectedRendererPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../renderer/index.html",
  );
  if (
    !isTrustedRendererUrl({
      url,
      packaged: app.isPackaged,
      expectedFilePath: expectedRendererPath,
      ...(!app.isPackaged && process.env.ELECTRON_RENDERER_URL != null
        ? { developmentUrl: process.env.ELECTRON_RENDERER_URL }
        : {}),
    })
  ) {
    throw new Error("Untrusted IPC sender.");
  }
}

function assertPayloadSize(input: unknown): void {
  if (input === undefined) return;
  if (serialize(input).byteLength > 1_000_000) {
    throw new Error("IPC payload exceeds the 1 MB limit.");
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "The request did not match the expected shape.";
  return error instanceof Error ? error.message : "The request failed.";
}
