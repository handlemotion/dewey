export type ToolRisk = "read" | "draft" | "write" | "financial" | "destructive";

export type ReasoningLevel = "focused" | "deep" | "maximum";
export type MalcolmDelegationMode =
  | "always-ask"
  | "ask-above-threshold"
  | "automatic-within-limits"
  | "never";

export type MalcolmTaskStatus =
  | "proposed"
  | "awaiting-approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ProposedAction = {
  tool: string;
  rationale: string;
  arguments: unknown;
  expectedEffect: string;
  estimatedCost?: string;
  risk: ToolRisk;
};

export type MalcolmTask = {
  id: string;
  objective: string;
  reasonForDelegation: string;
  expectedOutput: string;
  status: MalcolmTaskStatus;
  reasoningLevel: ReasoningLevel;
  model: string;
  estimatedCost?: number;
  actualCost?: number;
  progress?: string;
  result?: string;
  proposedActions?: ProposedAction[];
  createdAt: string;
  updatedAt: string;
};

export type ConsequentialAction = {
  id: string;
  tool: string;
  arguments: unknown;
  target: string;
  expectedEffect: string;
  risk: Exclude<ToolRisk, "read" | "draft">;
  costDescription?: string;
  irreversibility?: string;
  originatingTaskId: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired" | "executed" | "failed";
  createdAt: string;
};

export type Citation = {
  id: string;
  title: string;
  url: string;
  publishedAt?: string;
  excerpt?: string;
  sourceQuality?: string;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "dewey" | "malcolm" | "system";
  text: string;
  createdAt: string;
  isPartial?: boolean;
  citations?: Citation[];
};

export type DurableMemory = {
  id: string;
  kind: "fact" | "preference" | "relationship" | "routine" | "decision";
  content: string;
  sensitive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AppSettings = {
  handsFree: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  malcolmDelegationMode: MalcolmDelegationMode;
  malcolmCostThresholdUsd: number;
  malcolmAutomaticCeilingUsd: number;
  defaultReasoningLevel: ReasoningLevel;
  workspaceRoot: string | null;
  openaiConfigured: boolean;
  exaConfigured: boolean;
  firecrawlConfigured: boolean;
};

export type ConversationContextInput = {
  text: string;
  role?: "user" | "system";
};

export type ToolResult = {
  callId: string;
  output: unknown;
};

export type ConversationRuntimeEvent =
  | {
      type: "status";
      status: "idle" | "connecting" | "connected" | "listening" | "speaking" | "error";
      message?: string;
    }
  | {
      type: "transcript";
      role: "user" | "dewey";
      text: string;
      partial: boolean;
      messageId?: string;
      citations?: Citation[];
    }
  | { type: "tool-call"; callId: string; toolName: string; arguments: unknown }
  | { type: "tool-result"; callId: string; toolName: string; output: unknown }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      audioInputTokens: number;
      audioOutputTokens: number;
      cachedInputTokens: number;
      estimatedCostUsd?: number;
    }
  | { type: "input-level"; level: number };

export type ConversationRuntimeListener = (event: ConversationRuntimeEvent) => void;

export interface ConversationRuntime {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  startUserTurn(): Promise<void>;
  endUserTurn(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  interrupt(): Promise<void>;
  sendContext(input: ConversationContextInput): Promise<void>;
  submitToolResult(result: ToolResult): Promise<void>;
  subscribe(listener: ConversationRuntimeListener): () => void;
}

export type RealtimeSessionCredential = {
  token: string;
  url: string;
  model: string;
  expiresAt?: number;
  tools: Array<{
    type: "function";
    name: string;
    description?: string;
    parameters: unknown;
  }>;
};

export type ProviderStatus = {
  openai: boolean;
  exa: boolean;
  firecrawl: boolean;
};

export type CredentialProvider = "openai" | "exa" | "firecrawl";

export type CredentialStorageStatus = {
  available: boolean;
  backend: string;
};

export type BrowserProfile = {
  name: string;
  provider: "firecrawl";
  persistent: boolean;
  createdAt: string;
  lastUsedAt: string;
  revokedAt?: string;
  sessionOpen?: boolean;
};

export type BootstrapState = {
  settings: AppSettings;
  tasks: MalcolmTask[];
  approvals: ConsequentialAction[];
  memories: DurableMemory[];
  messages: ConversationMessage[];
  providers: ProviderStatus;
  credentialStorage: CredentialStorageStatus;
  browserProfiles: BrowserProfile[];
};

export type TaskProposalInput = {
  objective: string;
  reasonForDelegation: string;
  expectedOutput: string;
  reasoningLevel?: ReasoningLevel;
  explicitUserRequest?: boolean;
};

export type ActionApprovalInput = {
  approvalId: string;
  tool: string;
  arguments: unknown;
};

export type RealtimeUsageInput = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  cachedInputTokens: number;
  estimatedCostUsd: number;
};

export interface DeweyDesktopApi {
  bootstrap(): Promise<BootstrapState>;
  createRealtimeSession(): Promise<RealtimeSessionCredential>;
  executeRealtimeTool(input: {
    callId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<unknown>;
  recordMessage(message: ConversationMessage): Promise<void>;
  recordRealtimeUsage(input: RealtimeUsageInput): Promise<void>;
  proposeMalcolm(input: TaskProposalInput): Promise<MalcolmTask>;
  decideMalcolm(input: {
    taskId: string;
    decision: "approve" | "deny";
    editedObjective?: string;
  }): Promise<MalcolmTask>;
  cancelMalcolm(taskId: string): Promise<MalcolmTask>;
  decideAction(
    input: ActionApprovalInput & { decision: "approve" | "deny" },
  ): Promise<ConsequentialAction>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  selectWorkspace(): Promise<string | null>;
  configureProvider(input: {
    provider: CredentialProvider;
    apiKey: string;
  }): Promise<BootstrapState>;
  clearProvider(provider: CredentialProvider): Promise<BootstrapState>;
  beginBrowserProfile(name: string): Promise<BootstrapState>;
  finishBrowserProfile(name: string): Promise<BootstrapState>;
  revokeBrowserProfile(name: string): Promise<BootstrapState>;
  saveMemory(
    input: Pick<DurableMemory, "kind" | "content" | "sensitive"> & { approved: boolean },
  ): Promise<DurableMemory>;
  updateMemory(
    input: Pick<DurableMemory, "id" | "kind" | "content" | "sensitive"> & { approved: boolean },
  ): Promise<DurableMemory>;
  deleteMemory(id: string): Promise<void>;
  onTaskUpdate(listener: (task: MalcolmTask) => void): () => void;
  onActionUpdate(listener: (action: ConsequentialAction) => void): () => void;
  onMessageUpdate(listener: (message: ConversationMessage) => void): () => void;
}
