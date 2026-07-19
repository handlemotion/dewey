import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role", { enum: ["user", "dewey", "malcolm", "system"] }).notNull(),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
});

export const citations = sqliteTable("citations", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  publishedAt: text("published_at"),
  excerpt: text("excerpt"),
  sourceQuality: text("source_quality"),
});

export const toolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id"),
  tool: text("tool").notNull(),
  risk: text("risk", { enum: ["read", "draft", "write", "financial", "destructive"] }).notNull(),
  argumentsJson: text("arguments_json").notNull(),
  resultJson: text("result_json"),
  status: text("status").notNull(),
  estimatedCost: real("estimated_cost"),
  actualCost: real("actual_cost"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const malcolmTasks = sqliteTable("malcolm_tasks", {
  id: text("id").primaryKey(),
  objective: text("objective").notNull(),
  reasonForDelegation: text("reason_for_delegation").notNull(),
  expectedOutput: text("expected_output").notNull(),
  status: text("status").notNull(),
  reasoningLevel: text("reasoning_level").notNull(),
  model: text("model").notNull(),
  estimatedCost: real("estimated_cost"),
  actualCost: real("actual_cost"),
  progress: text("progress"),
  result: text("result"),
  proposedActionsJson: text("proposed_actions_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  tool: text("tool").notNull(),
  argumentsJson: text("arguments_json").notNull(),
  target: text("target").notNull(),
  expectedEffect: text("expected_effect").notNull(),
  risk: text("risk").notNull(),
  costDescription: text("cost_description"),
  irreversibility: text("irreversibility"),
  originatingTaskId: text("originating_task_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
  resultJson: text("result_json"),
  errorText: text("error_text"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  sensitive: integer("sensitive", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  event: text("event").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  audioInputTokens: integer("audio_input_tokens").notNull(),
  audioOutputTokens: integer("audio_output_tokens").notNull(),
  estimatedCost: real("estimated_cost"),
  actualCost: real("actual_cost"),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const providerMetadata = sqliteTable("provider_metadata", {
  provider: text("provider").primaryKey(),
  configured: integer("configured", { mode: "boolean" }).notNull(),
  credentialSource: text("credential_source").notNull(),
  lastValidatedAt: text("last_validated_at"),
  detailsJson: text("details_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const browserProfiles = sqliteTable("browser_profiles", {
  name: text("name").primaryKey(),
  provider: text("provider").notNull(),
  persistent: integer("persistent", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
  revokedAt: text("revoked_at"),
});
