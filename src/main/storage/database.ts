import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import type {
  AppSettings,
  BrowserProfile,
  ConsequentialAction,
  ConversationMessage,
  DurableMemory,
  MalcolmTask,
  ProposedAction,
} from "../../shared/contracts";
import { DEFAULT_SETTINGS } from "../../shared/policy";
import {
  approvals,
  auditEvents,
  browserProfiles,
  citations,
  conversations,
  malcolmTasks,
  memories,
  messages,
  providerMetadata,
  settings,
  toolCalls,
  usageEvents,
} from "./schema";

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  published_at TEXT, excerpt TEXT, source_quality TEXT
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, conversation_id TEXT, tool TEXT NOT NULL, risk TEXT NOT NULL,
  arguments_json TEXT NOT NULL, result_json TEXT, status TEXT NOT NULL,
  estimated_cost REAL, actual_cost REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS malcolm_tasks (
  id TEXT PRIMARY KEY, objective TEXT NOT NULL, reason_for_delegation TEXT NOT NULL,
  expected_output TEXT NOT NULL, status TEXT NOT NULL, reasoning_level TEXT NOT NULL,
  model TEXT NOT NULL, estimated_cost REAL, actual_cost REAL, progress TEXT, result TEXT,
  proposed_actions_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, arguments_json TEXT NOT NULL, target TEXT NOT NULL,
  expected_effect TEXT NOT NULL, risk TEXT NOT NULL, originating_task_id TEXT NOT NULL,
  expires_at TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL, sensitive INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS malcolm_tasks_status_idx ON malcolm_tasks(status, updated_at);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, expires_at);
`;

const MIGRATION_002 = `
ALTER TABLE approvals ADD COLUMN updated_at TEXT;
ALTER TABLE approvals ADD COLUMN result_json TEXT;
ALTER TABLE approvals ADD COLUMN error_text TEXT;
UPDATE approvals SET updated_at = created_at WHERE updated_at IS NULL;
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  audio_input_tokens INTEGER NOT NULL, audio_output_tokens INTEGER NOT NULL,
  estimated_cost REAL, actual_cost REAL, metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_metadata (
  provider TEXT PRIMARY KEY, configured INTEGER NOT NULL, credential_source TEXT NOT NULL,
  last_validated_at TEXT, details_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_profiles (
  name TEXT PRIMARY KEY, provider TEXT NOT NULL, persistent INTEGER NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS usage_events_scope_idx ON usage_events(scope, created_at);
CREATE INDEX IF NOT EXISTS tool_calls_status_idx ON tool_calls(status, updated_at);
`;

const MIGRATION_003 = `
ALTER TABLE approvals ADD COLUMN cost_description TEXT;
ALTER TABLE approvals ADD COLUMN irreversibility TEXT;
`;

const MIGRATIONS = [
  { version: 1, sql: MIGRATION_001 },
  { version: 2, sql: MIGRATION_002 },
  { version: 3, sql: MIGRATION_003 },
] as const;

const persistedSettingsSchema = z
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
    workspaceRoot: z.string().nullable(),
    openaiConfigured: z.boolean(),
    exaConfigured: z.boolean(),
    firecrawlConfigured: z.boolean(),
  })
  .partial();

export class DeweyStore {
  private readonly sqlite: Database.Database;
  private readonly db;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    secureFile(dirname(path), 0o700);
    this.sqlite = new Database(path);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.runMigrations();
    this.db = drizzle({ client: this.sqlite });
    this.ensureDefaultConversation();
    this.reconcileInterruptedWork();
    this.secureDatabaseFiles();
  }

  close(): void {
    this.sqlite.close();
  }

  getSettings(
    providerFlags: Pick<AppSettings, "openaiConfigured" | "exaConfigured" | "firecrawlConfigured">,
  ): AppSettings {
    const row = this.db.select().from(settings).where(eq(settings.key, "app")).get();
    const parsed =
      row == null ? undefined : persistedSettingsSchema.safeParse(safeParseJson(row.valueJson));
    const saved = parsed?.success
      ? (Object.fromEntries(
          Object.entries(parsed.data).filter((entry) => entry[1] !== undefined),
        ) as Partial<AppSettings>)
      : {};
    return { ...DEFAULT_SETTINGS, ...saved, ...providerFlags };
  }

  saveSettings(value: AppSettings): AppSettings {
    const updatedAt = new Date().toISOString();
    this.db
      .insert(settings)
      .values({ key: "app", valueJson: toPersistedJson(value), updatedAt })
      .onConflictDoUpdate({
        target: settings.key,
        set: { valueJson: toPersistedJson(value), updatedAt },
      })
      .run();
    this.audit("settings.updated", { changedAt: updatedAt });
    return value;
  }

  listTasks(): MalcolmTask[] {
    return this.db
      .select()
      .from(malcolmTasks)
      .orderBy(desc(malcolmTasks.updatedAt))
      .all()
      .map((row) => {
        const { estimatedCost, actualCost, progress, result, proposedActionsJson, ...required } =
          row;
        return {
          ...required,
          status: row.status as MalcolmTask["status"],
          reasoningLevel: row.reasoningLevel as MalcolmTask["reasoningLevel"],
          ...(estimatedCost == null ? {} : { estimatedCost }),
          ...(actualCost == null ? {} : { actualCost }),
          ...(progress == null ? {} : { progress }),
          ...(result == null ? {} : { result }),
          ...(proposedActionsJson == null
            ? {}
            : {
                proposedActions: readProposedActions(proposedActionsJson),
              }),
        };
      });
  }

  getTask(id: string): MalcolmTask | undefined {
    return this.listTasks().find((task) => task.id === id);
  }

  saveTask(task: MalcolmTask): MalcolmTask {
    const values = {
      id: task.id,
      objective: task.objective,
      reasonForDelegation: task.reasonForDelegation,
      expectedOutput: task.expectedOutput,
      status: task.status,
      reasoningLevel: task.reasoningLevel,
      model: task.model,
      estimatedCost: task.estimatedCost ?? null,
      actualCost: task.actualCost ?? null,
      progress: task.progress ?? null,
      result: task.result ?? null,
      proposedActionsJson:
        task.proposedActions == null ? null : toPersistedJson(task.proposedActions),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    this.db
      .insert(malcolmTasks)
      .values(values)
      .onConflictDoUpdate({ target: malcolmTasks.id, set: values })
      .run();
    this.audit("malcolm.task.updated", { id: task.id, status: task.status });
    return task;
  }

  listApprovals(): ConsequentialAction[] {
    return this.db
      .select()
      .from(approvals)
      .orderBy(desc(approvals.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        tool: row.tool,
        arguments: safeParseJson(row.argumentsJson),
        target: row.target,
        expectedEffect: row.expectedEffect,
        risk: row.risk as ConsequentialAction["risk"],
        ...(row.costDescription == null ? {} : { costDescription: row.costDescription }),
        ...(row.irreversibility == null ? {} : { irreversibility: row.irreversibility }),
        originatingTaskId: row.originatingTaskId,
        expiresAt: row.expiresAt,
        status: row.status as ConsequentialAction["status"],
        createdAt: row.createdAt,
      }));
  }

  saveApproval(
    action: ConsequentialAction,
    resolution?: { result?: unknown; error?: string },
  ): ConsequentialAction {
    const values = {
      id: action.id,
      tool: action.tool,
      argumentsJson: toPersistedJson(action.arguments),
      target: action.target,
      expectedEffect: action.expectedEffect,
      risk: action.risk,
      costDescription: action.costDescription ?? null,
      irreversibility: action.irreversibility ?? null,
      originatingTaskId: action.originatingTaskId,
      expiresAt: action.expiresAt,
      status: action.status,
      createdAt: action.createdAt,
      updatedAt: new Date().toISOString(),
      resultJson: resolution?.result == null ? null : toPersistedJson(resolution.result),
      errorText: resolution?.error ?? null,
    };
    this.db
      .insert(approvals)
      .values(values)
      .onConflictDoUpdate({ target: approvals.id, set: values })
      .run();
    this.audit("action.approval.updated", { id: action.id, status: action.status });
    return action;
  }

  listMemories(): DurableMemory[] {
    return this.db
      .select()
      .from(memories)
      .orderBy(desc(memories.updatedAt))
      .all()
      .map((row) => ({
        ...row,
        kind: row.kind as DurableMemory["kind"],
      }));
  }

  saveMemory(memory: DurableMemory): DurableMemory {
    this.db
      .insert(memories)
      .values(memory)
      .onConflictDoUpdate({
        target: memories.id,
        set: {
          kind: memory.kind,
          content: memory.content,
          sensitive: memory.sensitive,
          updatedAt: memory.updatedAt,
        },
      })
      .run();
    this.audit("memory.saved", { id: memory.id, sensitive: memory.sensitive });
    return memory;
  }

  deleteMemory(id: string): void {
    this.db.delete(memories).where(eq(memories.id, id)).run();
    this.audit("memory.deleted", { id });
  }

  listMessages(limit = 100): ConversationMessage[] {
    const rows = this.db
      .select()
      .from(messages)
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all()
      .reverse();
    const ids = rows.map((row) => row.id);
    const citationRows =
      ids.length === 0
        ? []
        : this.db.select().from(citations).where(inArray(citations.messageId, ids)).all();
    const byMessage = new Map<string, NonNullable<ConversationMessage["citations"]>>();
    for (const citation of citationRows) {
      const existing = byMessage.get(citation.messageId) ?? [];
      existing.push({
        id: citation.id,
        title: citation.title,
        url: citation.url,
        ...(citation.publishedAt == null ? {} : { publishedAt: citation.publishedAt }),
        ...(citation.excerpt == null ? {} : { excerpt: citation.excerpt }),
        ...(citation.sourceQuality == null ? {} : { sourceQuality: citation.sourceQuality }),
      });
      byMessage.set(citation.messageId, existing);
    }
    return rows.map((row) => {
      const messageCitations = byMessage.get(row.id);
      return {
        id: row.id,
        role: row.role as ConversationMessage["role"],
        text: row.text,
        createdAt: row.createdAt,
        ...(messageCitations == null ? {} : { citations: messageCitations }),
      };
    });
  }

  appendMessage(message: ConversationMessage, conversationId = "default"): void {
    this.sqlite.transaction(() => {
      this.db
        .insert(messages)
        .values({
          id: message.id,
          conversationId,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })
        .onConflictDoNothing()
        .run();
      for (const citation of message.citations ?? []) {
        this.db
          .insert(citations)
          .values({
            id: `${message.id}:${citation.id}`.slice(0, 512),
            messageId: message.id,
            title: citation.title,
            url: citation.url,
            publishedAt: citation.publishedAt ?? null,
            excerpt: citation.excerpt ?? null,
            sourceQuality: citation.sourceQuality ?? null,
          })
          .onConflictDoNothing()
          .run();
      }
      this.db
        .update(conversations)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, conversationId))
        .run();
    })();
  }

  startToolCall(input: {
    id: string;
    tool: string;
    risk: "read" | "draft" | "write" | "financial" | "destructive";
    arguments: unknown;
    estimatedCost?: number;
  }): void {
    const timestamp = new Date().toISOString();
    this.db
      .insert(toolCalls)
      .values({
        id: input.id,
        conversationId: "default",
        tool: input.tool,
        risk: input.risk,
        argumentsJson: toPersistedJson(input.arguments),
        resultJson: null,
        status: "running",
        estimatedCost: input.estimatedCost ?? null,
        actualCost: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .run();
  }

  finishToolCall(
    id: string,
    input:
      | { status: "completed"; result: unknown; actualCost?: number }
      | { status: "failed"; error: string },
  ): void {
    this.db
      .update(toolCalls)
      .set({
        status: input.status,
        resultJson:
          input.status === "completed"
            ? toPersistedJson(input.result)
            : toPersistedJson({ error: input.error }),
        actualCost: input.status === "completed" ? (input.actualCost ?? null) : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(toolCalls.id, id))
      .run();
  }

  recordUsage(input: {
    scope: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    audioInputTokens?: number;
    audioOutputTokens?: number;
    estimatedCost?: number;
    actualCost?: number;
    metadata?: unknown;
  }): void {
    this.db
      .insert(usageEvents)
      .values({
        id: crypto.randomUUID(),
        scope: input.scope,
        model: input.model,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        audioInputTokens: input.audioInputTokens ?? 0,
        audioOutputTokens: input.audioOutputTokens ?? 0,
        estimatedCost: input.estimatedCost ?? null,
        actualCost: input.actualCost ?? null,
        metadataJson: toPersistedJson(input.metadata ?? {}),
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  syncProviderMetadata(input: {
    provider: string;
    configured: boolean;
    credentialSource: string;
    details?: unknown;
    validated?: boolean;
  }): void {
    const updatedAt = new Date().toISOString();
    this.db
      .insert(providerMetadata)
      .values({
        provider: input.provider,
        configured: input.configured,
        credentialSource: input.credentialSource,
        lastValidatedAt: input.validated ? updatedAt : null,
        detailsJson: toPersistedJson(input.details ?? {}),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: providerMetadata.provider,
        set: {
          configured: input.configured,
          credentialSource: input.credentialSource,
          ...(input.validated ? { lastValidatedAt: updatedAt } : {}),
          detailsJson: toPersistedJson(input.details ?? {}),
          updatedAt,
        },
      })
      .run();
  }

  saveBrowserProfile(name: string): BrowserProfile {
    const existing = this.db
      .select()
      .from(browserProfiles)
      .where(eq(browserProfiles.name, name))
      .get();
    const timestamp = new Date().toISOString();
    const values = {
      name,
      provider: "firecrawl" as const,
      persistent: true,
      createdAt: existing?.createdAt ?? timestamp,
      lastUsedAt: timestamp,
      revokedAt: null,
    };
    this.db
      .insert(browserProfiles)
      .values(values)
      .onConflictDoUpdate({ target: browserProfiles.name, set: values })
      .run();
    return {
      name: values.name,
      provider: values.provider,
      persistent: values.persistent,
      createdAt: values.createdAt,
      lastUsedAt: values.lastUsedAt,
    };
  }

  listBrowserProfiles(): BrowserProfile[] {
    return this.db
      .select()
      .from(browserProfiles)
      .orderBy(desc(browserProfiles.lastUsedAt))
      .all()
      .map((row) => ({
        name: row.name,
        provider: "firecrawl",
        persistent: row.persistent,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        ...(row.revokedAt == null ? {} : { revokedAt: row.revokedAt }),
      }));
  }

  touchBrowserProfile(name: string): BrowserProfile {
    const profile = this.listBrowserProfiles().find((candidate) => candidate.name === name);
    if (profile == null || profile.revokedAt != null) {
      throw new Error("This browser profile is not active. Create it visibly in Settings first.");
    }
    const lastUsedAt = new Date().toISOString();
    this.db.update(browserProfiles).set({ lastUsedAt }).where(eq(browserProfiles.name, name)).run();
    return { ...profile, lastUsedAt };
  }

  revokeBrowserProfile(name: string): void {
    const revokedAt = new Date().toISOString();
    this.db
      .update(browserProfiles)
      .set({ revokedAt, persistent: false })
      .where(eq(browserProfiles.name, name))
      .run();
    this.audit("browser.profile.revoked", { name });
  }

  audit(event: string, details: unknown): void {
    this.db
      .insert(auditEvents)
      .values({
        id: crypto.randomUUID(),
        event,
        detailsJson: toPersistedJson(details),
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  private runMigrations(): void {
    let currentVersion = this.sqlite.pragma("user_version", { simple: true }) as number;
    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      this.sqlite.transaction(() => {
        this.sqlite.exec(migration.sql);
        this.sqlite.pragma(`user_version = ${migration.version}`);
      })();
      currentVersion = migration.version;
    }
  }

  private ensureDefaultConversation(): void {
    const timestamp = new Date().toISOString();
    this.db
      .insert(conversations)
      .values({
        id: "default",
        title: "Dewey",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .run();
  }

  private reconcileInterruptedWork(): void {
    const timestamp = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE malcolm_tasks
         SET status = 'failed', progress = 'Interrupted when Dewey closed', updated_at = ?
         WHERE status = 'running'`,
      )
      .run(timestamp);
    this.sqlite
      .prepare(
        `UPDATE tool_calls
         SET status = 'failed',
             result_json = '{"error":"Interrupted when Dewey closed"}',
             updated_at = ?
         WHERE status = 'running'`,
      )
      .run(timestamp);
    this.sqlite
      .prepare(
        `UPDATE approvals
         SET status = 'expired', updated_at = ?
         WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(timestamp, timestamp);
    this.sqlite
      .prepare(
        `UPDATE approvals
         SET status = 'failed',
             error_text = 'Interrupted before the approved action completed',
             updated_at = ?
         WHERE status = 'approved'`,
      )
      .run(timestamp);
  }

  private secureDatabaseFiles(): void {
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(path)) secureFile(path, 0o600);
    }
  }
}

function toPersistedJson(value: unknown): string {
  const json =
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Error) return { name: item.name, message: item.message };
      return item;
    }) ?? "null";
  if (json.length <= 500_000) return json;
  return JSON.stringify({
    truncated: true,
    originalCharacters: json.length,
    preview: json.slice(0, 499_000),
  });
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readProposedActions(value: string): ProposedAction[] {
  const parsed = safeParseJson(value);
  return Array.isArray(parsed) ? (parsed as ProposedAction[]) : [];
}

function secureFile(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // OS-level access controls may not expose POSIX modes.
  }
}
