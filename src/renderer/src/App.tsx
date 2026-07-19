import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppSettings,
  BootstrapState,
  BrowserProfile,
  Citation,
  ConsequentialAction,
  ConversationMessage,
  ConversationRuntimeEvent,
  CredentialProvider,
  CredentialStorageStatus,
  DurableMemory,
  MalcolmTask,
} from "../../shared/contracts";
import { OpenAIConversationRuntime } from "../runtime/openai-conversation-runtime";

type RuntimeStatus = "idle" | "connecting" | "connected" | "listening" | "speaking" | "error";

const STATUS_COPY: Record<RuntimeStatus, string> = {
  idle: "Ready when you are",
  connecting: "Connecting",
  connected: "I’m here",
  listening: "Listening",
  speaking: "Speaking",
  error: "Something needs attention",
};

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>();
  const [bootError, setBootError] = useState<string>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [tasks, setTasks] = useState<MalcolmTask[]>([]);
  const [approvals, setApprovals] = useState<ConsequentialAction[]>([]);
  const [status, setStatus] = useState<RuntimeStatus>("idle");
  const [error, setError] = useState<string>();
  const [composer, setComposer] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [sessionCost, setSessionCost] = useState(0);
  const [muted, setMuted] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [lastTool, setLastTool] = useState<string>();
  const [lastCitations, setLastCitations] = useState<Citation[]>([]);
  const runtimeRef = useRef<OpenAIConversationRuntime | undefined>(undefined);
  const partialMessageId = useRef<string | undefined>(undefined);
  const latestCompletedTasks = useRef(new Set<string>());

  useEffect(() => {
    void window.dewey
      .bootstrap()
      .then((state) => {
        setBootstrap(state);
        setMessages(state.messages);
        setTasks(state.tasks);
        setApprovals(state.approvals);
        for (const task of state.tasks) {
          if (task.status === "completed") latestCompletedTasks.current.add(task.id);
        }
      })
      .catch((caught: unknown) => {
        setBootError(caught instanceof Error ? caught.message : String(caught));
      });
    const offTask = window.dewey.onTaskUpdate((task) => {
      setTasks((current) => upsert(current, task));
      if (
        task.status === "completed" &&
        !latestCompletedTasks.current.has(task.id) &&
        task.result != null
      ) {
        latestCompletedTasks.current.add(task.id);
        void runtimeRef.current?.sendContext({
          role: "system",
          text: `Malcolm has completed the approved task. Present this result naturally, with its caveats and any proposed actions:\n\n${task.result}`,
        });
      }
    });
    const offAction = window.dewey.onActionUpdate((action) =>
      setApprovals((current) => upsert(current, action)),
    );
    const offMessage = window.dewey.onMessageUpdate((message) =>
      setMessages((current) => upsert(current, message)),
    );
    return () => {
      offTask();
      offAction();
      offMessage();
      void runtimeRef.current?.disconnect();
    };
  }, []);

  const settings = bootstrap?.settings;
  const activeTask = useMemo(
    () => tasks.find((task) => task.status === "running" || task.status === "awaiting-approval"),
    [tasks],
  );
  const pendingApprovals = useMemo(
    () => approvals.filter((action) => action.status === "pending"),
    [approvals],
  );

  async function ensureRuntime(): Promise<OpenAIConversationRuntime> {
    if (runtimeRef.current != null) return runtimeRef.current;
    const runtime = new OpenAIConversationRuntime(settings?.handsFree ?? false);
    runtime.subscribe(handleRuntimeEvent);
    runtimeRef.current = runtime;
    await runtime.connect();
    if (settings?.handsFree) await refreshDevices();
    return runtime;
  }

  function handleRuntimeEvent(event: ConversationRuntimeEvent): void {
    if (event.type === "input-level") {
      setInputLevel(event.level);
      return;
    }
    if (event.type === "status") {
      setStatus(event.status);
      if (event.status === "error") setError(event.message ?? "Realtime session failed.");
      return;
    }
    if (event.type === "usage") {
      setSessionCost((cost) => cost + (event.estimatedCostUsd ?? 0));
      return;
    }
    if (event.type === "tool-call") {
      setLastTool(event.toolName);
      return;
    }
    if (event.type === "tool-result") {
      setLastCitations(readCitations(event.output));
      return;
    }
    if (event.type === "transcript") {
      const id = event.messageId ?? partialMessageId.current ?? crypto.randomUUID();
      if (event.partial) {
        partialMessageId.current = id;
      } else {
        partialMessageId.current = undefined;
      }
      const message: ConversationMessage = {
        id,
        role: event.role,
        text: event.text,
        ...(event.partial ? { isPartial: true } : {}),
        ...(event.citations == null ? {} : { citations: event.citations }),
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => upsert(current, message));
    }
  }

  async function handleConnect(): Promise<void> {
    setError(undefined);
    try {
      await ensureRuntime();
      await refreshDevices();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
    }
  }

  function reportError(caught: unknown): void {
    setError(caught instanceof Error ? caught.message : String(caught));
  }

  async function handlePushStart(event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    try {
      await (await ensureRuntime()).startUserTurn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
    }
  }

  async function handlePushEnd() {
    await runtimeRef.current?.endUserTurn();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = composer.trim();
    if (text.length === 0) return;
    setComposer("");
    try {
      await (await ensureRuntime()).sendContext({ text });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
    }
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    if (settings == null) return;
    const updated = await window.dewey.updateSettings(patch);
    setBootstrap((current) => (current == null ? current : { ...current, settings: updated }));
    if (patch.handsFree != null) {
      await runtimeRef.current?.disconnect();
      runtimeRef.current = undefined;
      setMuted(false);
      return;
    }
    if (patch.inputDeviceId != null) {
      await runtimeRef.current?.setInputDevice(patch.inputDeviceId);
    }
    if (patch.outputDeviceId != null) {
      await runtimeRef.current?.setOutputDevice(patch.outputDeviceId);
    }
  }

  async function toggleMute() {
    const next = !muted;
    await runtimeRef.current?.setMuted(next);
    setMuted(next);
  }

  function storeMemory(memory: DurableMemory) {
    setBootstrap((current) =>
      current == null ? current : { ...current, memories: upsert(current.memories, memory) },
    );
    resetRuntimeContext();
  }

  function removeMemory(id: string) {
    setBootstrap((current) =>
      current == null
        ? current
        : {
            ...current,
            memories: current.memories.filter((memory) => memory.id !== id),
          },
    );
    resetRuntimeContext();
  }

  function resetRuntimeContext() {
    const runtime = runtimeRef.current;
    runtimeRef.current = undefined;
    setMuted(false);
    setStatus("idle");
    if (runtime != null) void runtime.disconnect().catch(reportError);
  }

  async function refreshDevices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list);
  }

  if (bootstrap == null || settings == null) {
    return (
      <div className="boot">
        {bootError == null ? (
          "Opening Dewey…"
        ) : (
          <>
            <p>Dewey could not open.</p>
            <span>{bootError}</span>
            <button type="button" onClick={() => window.location.reload()}>
              Retry
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="titlebar-mark">
          <span className="mark-dot" />
          <span>Dewey</span>
        </div>
        <div className="session-meta">
          <span>{sessionCost < 0.01 ? "< $0.01" : `$${sessionCost.toFixed(2)}`}</span>
          <button className="text-button" type="button" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      <section className="workspace">
        <section className="conversation-panel">
          <div className="presence">
            <ListeningOrb status={status} inputLevel={inputLevel} />
            <div>
              <p className="presence-name">Dewey</p>
              <p className="presence-status">{STATUS_COPY[status]}</p>
            </div>
          </div>

          <div className="transcript" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                <p>Talk to me naturally.</p>
                <span>
                  I can answer directly, use fast tools, or ask before bringing Malcolm in.
                </span>
              </div>
            ) : (
              messages.map((message) => <MessageRow key={message.id} message={message} />)
            )}
          </div>

          {error != null && (
            <div className="error-banner">
              <span>{error}</span>
              <button type="button" onClick={() => setError(undefined)}>
                Dismiss
              </button>
            </div>
          )}

          <form className="composer" onSubmit={handleSubmit}>
            <input
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="Type to Dewey"
              aria-label="Message Dewey"
            />
            <button type="submit" disabled={composer.trim().length === 0}>
              Send
            </button>
          </form>

          <div className="voice-controls">
            {status === "idle" || status === "error" ? (
              <button className="connect-button" type="button" onClick={handleConnect}>
                Start conversation
              </button>
            ) : settings.handsFree ? (
              <button
                className="control-button interrupt"
                type="button"
                onClick={() => runtimeRef.current?.interrupt()}
              >
                Interrupt
              </button>
            ) : (
              <button
                className="push-button"
                type="button"
                onPointerDown={handlePushStart}
                onPointerUp={handlePushEnd}
                onPointerCancel={handlePushEnd}
              >
                <span className="mic-glyph" />
                Hold to talk
              </button>
            )}
            {status !== "idle" && status !== "error" && (
              <button
                className={`control-button ${muted ? "muted" : ""}`}
                type="button"
                onClick={toggleMute}
              >
                {muted ? "Unmute" : "Mute"}
              </button>
            )}
            <label className="handsfree-toggle">
              <input
                type="checkbox"
                checked={settings.handsFree}
                onChange={(event) => updateSettings({ handsFree: event.target.checked })}
              />
              <span>Hands-free</span>
            </label>
          </div>
        </section>

        <aside className="activity-panel">
          <div className="activity-heading">
            <p>Activity</p>
            <span>{activeTask == null ? "Quiet" : "In progress"}</span>
          </div>

          {lastTool != null && (
            <div className="tool-status">
              <span className="tool-pulse" />
              <span>Latest tool</span>
              <strong>{humanizeTool(lastTool)}</strong>
            </div>
          )}

          {lastCitations.length > 0 && (
            <div className="source-card">
              <p>Sources</p>
              {lastCitations.slice(0, 5).map((citation) => (
                <a key={citation.id} href={citation.url} target="_blank" rel="noreferrer">
                  <span>{citation.title}</span>
                  <small>{citation.sourceQuality ?? citationHost(citation.url)}</small>
                </a>
              ))}
            </div>
          )}

          {activeTask == null && pendingApprovals.length === 0 ? (
            <div className="quiet-card">
              <span className="quiet-line" />
              <p>Tools and delegated work appear here when they need your attention.</p>
            </div>
          ) : null}

          {tasks
            .filter((task) => task.status !== "cancelled")
            .slice(-4)
            .reverse()
            .map((task) => (
              <MalcolmCard
                key={task.id}
                task={task}
                onDecision={(decision, editedObjective) =>
                  window.dewey.decideMalcolm({
                    taskId: task.id,
                    decision,
                    ...(editedObjective == null ? {} : { editedObjective }),
                  })
                }
                onCancel={() => window.dewey.cancelMalcolm(task.id)}
              />
            ))}

          {pendingApprovals.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              onDecision={(decision) =>
                window.dewey.decideAction({
                  approvalId: action.id,
                  tool: action.tool,
                  arguments: action.arguments,
                  decision,
                })
              }
            />
          ))}
        </aside>
      </section>

      {settingsOpen && (
        <SettingsSheet
          settings={settings}
          memories={bootstrap.memories}
          credentialStorage={bootstrap.credentialStorage}
          browserProfiles={bootstrap.browserProfiles}
          devices={devices}
          onClose={() => setSettingsOpen(false)}
          onError={reportError}
          onUpdate={updateSettings}
          onRefreshDevices={refreshDevices}
          onSelectWorkspace={async () => {
            const workspaceRoot = await window.dewey.selectWorkspace();
            setBootstrap((current) =>
              current == null
                ? current
                : {
                    ...current,
                    settings: { ...current.settings, workspaceRoot },
                  },
            );
          }}
          onConfigureProvider={async (provider, apiKey) => {
            const next = await window.dewey.configureProvider({ provider, apiKey });
            setBootstrap(next);
          }}
          onClearProvider={async (provider) => {
            const next = await window.dewey.clearProvider(provider);
            setBootstrap(next);
            if (provider === "openai") {
              await runtimeRef.current?.disconnect();
              runtimeRef.current = undefined;
            }
          }}
          onBeginBrowserProfile={async (name) => {
            setBootstrap(await window.dewey.beginBrowserProfile(name));
          }}
          onFinishBrowserProfile={async (name) => {
            setBootstrap(await window.dewey.finishBrowserProfile(name));
          }}
          onRevokeBrowserProfile={async (name) => {
            setBootstrap(await window.dewey.revokeBrowserProfile(name));
          }}
          onSaveMemory={async (input) => {
            const memory = await window.dewey.saveMemory(input);
            storeMemory(memory);
          }}
          onUpdateMemory={async (input) => {
            const memory = await window.dewey.updateMemory(input);
            storeMemory(memory);
          }}
          onDeleteMemory={async (id) => {
            await window.dewey.deleteMemory(id);
            removeMemory(id);
          }}
        />
      )}
    </main>
  );
}

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD
 *
 *    0ms   orb rests at the connected state
 *   80ms   state color and halo begin changing
 *  240ms   listening or speaking pulse settles
 * ───────────────────────────────────────────────────────── */
const ORB = {
  connectedScale: 1,
  activeScale: 1.05,
};

function ListeningOrb({ status, inputLevel }: { status: RuntimeStatus; inputLevel: number }) {
  const active = status === "listening" || status === "speaking";
  const activityScale = status === "listening" ? inputLevel * 0.08 : 0;
  return (
    <div
      className={`orb orb-${status}`}
      style={{
        transform: `scale(${(active ? ORB.activeScale : ORB.connectedScale) + activityScale})`,
      }}
      aria-hidden="true"
    >
      <span />
    </div>
  );
}

function MessageRow({ message }: { message: ConversationMessage }) {
  return (
    <article className={`message message-${message.role}`}>
      <p className="message-role">{message.role === "user" ? "You" : message.role}</p>
      <p className={message.isPartial ? "partial" : undefined}>{message.text}</p>
      {message.citations?.map((citation) => (
        <a key={citation.id} href={citation.url} target="_blank" rel="noreferrer">
          {citation.title}
        </a>
      ))}
    </article>
  );
}

function MalcolmCard({
  task,
  onDecision,
  onCancel,
}: {
  task: MalcolmTask;
  onDecision: (decision: "approve" | "deny", editedObjective?: string) => Promise<MalcolmTask>;
  onCancel: () => Promise<MalcolmTask>;
}) {
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  useEffect(() => setObjective(task.objective), [task.objective]);
  return (
    <article className={`activity-card malcolm-card status-${task.status}`}>
      <div className="card-kicker">
        <span className="malcolm-dot" />
        <span>{task.status === "running" ? "Malcolm is working" : "Malcolm"}</span>
      </div>
      {editing ? (
        <textarea
          aria-label="Edit Malcolm task objective"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
        />
      ) : (
        <h2>{task.objective}</h2>
      )}
      <p>{task.progress ?? task.reasonForDelegation}</p>
      {task.status === "awaiting-approval" && (
        <>
          <p>Expected result: {task.expectedOutput}</p>
          <p>May continue beyond a brief conversational turn.</p>
        </>
      )}
      <dl>
        <div>
          <dt>Model</dt>
          <dd>{task.model}</dd>
        </div>
        <div>
          <dt>Effort</dt>
          <dd>{task.reasoningLevel}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            {task.actualCost != null
              ? `$${task.actualCost.toFixed(2)}`
              : task.estimatedCost != null
                ? `~$${task.estimatedCost.toFixed(2)}`
                : "Usage-based"}
          </dd>
        </div>
      </dl>
      {task.status === "awaiting-approval" && (
        <div className="card-actions">
          <button type="button" onClick={() => onDecision("deny")}>
            Deny
          </button>
          <button type="button" onClick={() => setEditing((value) => !value)}>
            {editing ? "Cancel edit" : "Edit task"}
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => onDecision("approve", editing ? objective : undefined)}
          >
            Approve
          </button>
        </div>
      )}
      {task.status === "running" && (
        <button className="subtle-danger" type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
      {task.status === "completed" && task.result != null && (
        <details>
          <summary>Read result</summary>
          <p className="task-result">{task.result}</p>
        </details>
      )}
      {task.proposedActions != null && task.proposedActions.length > 0 && (
        <div className="proposed-actions">
          <p>Proposed next steps — not executed</p>
          {task.proposedActions.map((action) => (
            <div
              className="proposed-action-item"
              key={`${action.tool}-${action.expectedEffect}-${action.rationale}`}
            >
              <strong>{action.expectedEffect}</strong>
              <span>{action.rationale}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function ActionCard({
  action,
  onDecision,
}: {
  action: ConsequentialAction;
  onDecision: (decision: "approve" | "deny") => Promise<ConsequentialAction>;
}) {
  return (
    <article className="activity-card action-card">
      <div className="card-kicker danger">
        <span>Approval required</span>
        <span>{action.risk}</span>
      </div>
      <h2>{action.expectedEffect}</h2>
      <p>Target: {action.target}</p>
      {action.costDescription != null && <p>Cost: {action.costDescription}</p>}
      {action.irreversibility != null && <p>Irreversibility: {action.irreversibility}</p>}
      <pre>{JSON.stringify(action.arguments, null, 2)}</pre>
      <div className="card-actions">
        <button type="button" onClick={() => onDecision("deny")}>
          Deny
        </button>
        <button className="primary" type="button" onClick={() => onDecision("approve")}>
          Approve exact action
        </button>
      </div>
    </article>
  );
}

function SettingsSheet({
  settings,
  memories,
  credentialStorage,
  browserProfiles,
  devices,
  onClose,
  onError,
  onUpdate,
  onRefreshDevices,
  onSelectWorkspace,
  onConfigureProvider,
  onClearProvider,
  onBeginBrowserProfile,
  onFinishBrowserProfile,
  onRevokeBrowserProfile,
  onSaveMemory,
  onUpdateMemory,
  onDeleteMemory,
}: {
  settings: AppSettings;
  memories: DurableMemory[];
  credentialStorage: CredentialStorageStatus;
  browserProfiles: BrowserProfile[];
  devices: MediaDeviceInfo[];
  onClose: () => void;
  onError: (error: unknown) => void;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
  onRefreshDevices: () => Promise<void>;
  onSelectWorkspace: () => Promise<void>;
  onConfigureProvider: (provider: CredentialProvider, apiKey: string) => Promise<void>;
  onClearProvider: (provider: CredentialProvider) => Promise<void>;
  onBeginBrowserProfile: (name: string) => Promise<void>;
  onFinishBrowserProfile: (name: string) => Promise<void>;
  onRevokeBrowserProfile: (name: string) => Promise<void>;
  onSaveMemory: (
    input: Pick<DurableMemory, "kind" | "content" | "sensitive"> & {
      approved: boolean;
    },
  ) => Promise<void>;
  onUpdateMemory: (
    input: Pick<DurableMemory, "id" | "kind" | "content" | "sensitive"> & {
      approved: boolean;
    },
  ) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  const update = (patch: Partial<AppSettings>) => {
    void onUpdate(patch).catch(onError);
  };
  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-label="Dewey settings"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <section className="settings-sheet">
        <header>
          <div>
            <p>Settings</p>
            <span>Local preferences and provider status</span>
          </div>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </header>
        <div className="settings-group">
          <h2>Audio</h2>
          <label>
            Microphone
            <select
              value={settings.inputDeviceId}
              onFocus={onRefreshDevices}
              onChange={(event) => update({ inputDeviceId: event.target.value })}
            >
              <option value="default">System default</option>
              {inputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || "Microphone"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Speaker
            <select
              value={settings.outputDeviceId}
              onFocus={onRefreshDevices}
              onChange={(event) => update({ outputDeviceId: event.target.value })}
            >
              <option value="default">System default</option>
              {outputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || "Speaker"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="settings-group">
          <h2>Malcolm delegation</h2>
          <label>
            Permission
            <select
              value={settings.malcolmDelegationMode}
              onChange={(event) =>
                update({
                  malcolmDelegationMode: event.target.value as AppSettings["malcolmDelegationMode"],
                })
              }
            >
              <option value="always-ask">Always ask</option>
              <option value="ask-above-threshold">Ask above cost threshold</option>
              <option value="automatic-within-limits">Automatic within limits</option>
              <option value="never">Never</option>
            </select>
          </label>
          <label>
            Default effort
            <select
              value={settings.defaultReasoningLevel}
              onChange={(event) =>
                update({
                  defaultReasoningLevel: event.target.value as AppSettings["defaultReasoningLevel"],
                })
              }
            >
              <option value="focused">Focused</option>
              <option value="deep">Deep</option>
              <option value="maximum">Maximum</option>
            </select>
          </label>
          <label>
            Ask above estimated cost (USD)
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={settings.malcolmCostThresholdUsd}
              onChange={(event) =>
                update({
                  malcolmCostThresholdUsd: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Automatic delegation ceiling (USD)
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={settings.malcolmAutomaticCeilingUsd}
              onChange={(event) =>
                update({
                  malcolmAutomaticCeilingUsd: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
        <div className="settings-group">
          <h2>Workspace</h2>
          <p className="settings-note">
            Malcolm can read only selected text and source files inside this folder.
          </p>
          <div className="provider-row">
            <span>{settings.workspaceRoot ?? "No workspace selected"}</span>
            <button type="button" onClick={() => void onSelectWorkspace().catch(onError)}>
              Choose folder
            </button>
          </div>
        </div>
        <div className="settings-group">
          <h2>Providers</h2>
          <p className="settings-note">
            Keys are encrypted by {credentialStorage.backend}. They are never shown again.
          </p>
          <ProviderRow
            provider="openai"
            name="OpenAI"
            configured={settings.openaiConfigured}
            storageAvailable={credentialStorage.available}
            onConfigure={onConfigureProvider}
            onClear={onClearProvider}
            onError={onError}
          />
          <ProviderRow
            provider="exa"
            name="Exa"
            configured={settings.exaConfigured}
            storageAvailable={credentialStorage.available}
            onConfigure={onConfigureProvider}
            onClear={onClearProvider}
            onError={onError}
          />
          <ProviderRow
            provider="firecrawl"
            name="Firecrawl"
            configured={settings.firecrawlConfigured}
            storageAvailable={credentialStorage.available}
            onConfigure={onConfigureProvider}
            onClear={onClearProvider}
            onError={onError}
          />
        </div>
        {settings.firecrawlConfigured && (
          <BrowserProfileSettings
            profiles={browserProfiles}
            onBegin={onBeginBrowserProfile}
            onFinish={onFinishBrowserProfile}
            onRevoke={onRevokeBrowserProfile}
            onError={onError}
          />
        )}
        <MemorySettings
          memories={memories}
          onSave={onSaveMemory}
          onUpdate={onUpdateMemory}
          onDelete={onDeleteMemory}
        />
      </section>
    </dialog>
  );
}

function MemorySettings({
  memories,
  onSave,
  onUpdate,
  onDelete,
}: {
  memories: DurableMemory[];
  onSave: (
    input: Pick<DurableMemory, "kind" | "content" | "sensitive"> & {
      approved: boolean;
    },
  ) => Promise<void>;
  onUpdate: (
    input: Pick<DurableMemory, "id" | "kind" | "content" | "sensitive"> & {
      approved: boolean;
    },
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [approved, setApproved] = useState(false);
  return (
    <div className="settings-group memory-settings">
      <h2>Durable memory</h2>
      <p className="settings-note">
        Memories stay in the local database and become model context. Sensitive items require
        explicit confirmation.
      </p>
      {memories.map((memory) => (
        <MemoryRow key={memory.id} memory={memory} onUpdate={onUpdate} onDelete={onDelete} />
      ))}
      <label>
        New memory
        <textarea
          value={draft}
          placeholder="A fact, preference, routine, or decision"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={sensitive}
          onChange={(event) => {
            setSensitive(event.target.checked);
            setApproved(false);
          }}
        />
        Sensitive
      </label>
      {sensitive && (
        <label className="check-row approval-check">
          <input
            type="checkbox"
            checked={approved}
            onChange={(event) => setApproved(event.target.checked)}
          />
          I approve storing this sensitive memory locally
        </label>
      )}
      <button
        type="button"
        disabled={draft.trim().length === 0 || (sensitive && !approved)}
        onClick={async () => {
          await onSave({
            kind: "fact",
            content: draft,
            sensitive,
            approved,
          });
          setDraft("");
          setSensitive(false);
          setApproved(false);
        }}
      >
        Add memory
      </button>
    </div>
  );
}

function MemoryRow({
  memory,
  onUpdate,
  onDelete,
}: {
  memory: DurableMemory;
  onUpdate: (
    input: Pick<DurableMemory, "id" | "kind" | "content" | "sensitive"> & {
      approved: boolean;
    },
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [approved, setApproved] = useState(false);
  useEffect(() => setContent(memory.content), [memory.content]);
  const dirty = content.trim() !== memory.content;
  return (
    <div className="memory-row">
      <textarea
        aria-label={`Edit ${memory.kind} memory`}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="memory-row-meta">
        <span>
          {memory.kind}
          {memory.sensitive ? " · sensitive" : ""}
        </span>
        <div className="memory-actions">
          <button className="subtle-danger" type="button" onClick={() => onDelete(memory.id)}>
            Delete
          </button>
          {memory.sensitive && dirty && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={approved}
                onChange={(event) => setApproved(event.target.checked)}
              />
              Approve sensitive update
            </label>
          )}
          <button
            type="button"
            disabled={!dirty || (memory.sensitive && !approved)}
            onClick={() =>
              onUpdate({
                id: memory.id,
                kind: memory.kind,
                content,
                sensitive: memory.sensitive,
                approved,
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  name,
  configured,
  storageAvailable,
  onConfigure,
  onClear,
  onError,
}: {
  provider: CredentialProvider;
  name: string;
  configured: boolean;
  storageAvailable: boolean;
  onConfigure: (provider: CredentialProvider, apiKey: string) => Promise<void>;
  onClear: (provider: CredentialProvider) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="provider-row"
      onSubmit={async (event) => {
        event.preventDefault();
        if (apiKey.trim().length < 8) return;
        setBusy(true);
        try {
          await onConfigure(provider, apiKey);
          setApiKey("");
        } catch (error) {
          onError(error);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span>{name}</span>
      {!configured && (
        <input
          type="password"
          autoComplete="off"
          aria-label={`${name} API key`}
          value={apiKey}
          disabled={!storageAvailable || busy}
          placeholder={`${name} API key`}
          onChange={(event) => setApiKey(event.target.value)}
        />
      )}
      {configured ? (
        <button
          type="button"
          className="subtle-danger"
          onClick={() => void onClear(provider).catch(onError)}
        >
          Remove
        </button>
      ) : (
        <button type="submit" disabled={!storageAvailable || busy || apiKey.trim().length < 8}>
          Save
        </button>
      )}
    </form>
  );
}

function BrowserProfileSettings({
  profiles,
  onBegin,
  onFinish,
  onRevoke,
  onError,
}: {
  profiles: BrowserProfile[];
  onBegin: (name: string) => Promise<void>;
  onFinish: (name: string) => Promise<void>;
  onRevoke: (name: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="settings-group">
      <h2>Browser profiles</h2>
      <p className="settings-note">
        Authentication opens in a visible Firecrawl session. Dewey cannot type passwords.
      </p>
      {profiles
        .filter((profile) => profile.revokedAt == null)
        .map((profile) => (
          <div className="provider-row" key={profile.name}>
            <span>{profile.name}</span>
            <div className="memory-actions">
              {profile.sessionOpen === true && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await onFinish(profile.name);
                    } catch (error) {
                      onError(error);
                    }
                  }}
                >
                  Finish login
                </button>
              )}
              <button
                type="button"
                className="subtle-danger"
                onClick={() => void onRevoke(profile.name).catch(onError)}
              >
                Revoke
              </button>
            </div>
          </div>
        ))}
      <form
        className="provider-row"
        onSubmit={async (event) => {
          event.preventDefault();
          const profileName = name.trim();
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profileName)) return;
          try {
            await onBegin(profileName);
            setName("");
          } catch (error) {
            onError(error);
          }
        }}
      >
        <input
          value={name}
          placeholder="Profile name"
          pattern="[a-zA-Z0-9_-]{1,64}"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" disabled={!/^[a-zA-Z0-9_-]{1,64}$/.test(name.trim())}>
          Open login
        </button>
      </form>
    </div>
  );
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function humanizeTool(toolName: string): string {
  return toolName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function citationHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "Source";
  }
}

function readCitations(output: unknown): Citation[] {
  if (output == null || typeof output !== "object" || !("citations" in output)) return [];
  const citations = (output as { citations?: unknown }).citations;
  if (!Array.isArray(citations)) return [];
  return citations.filter(
    (citation): citation is Citation =>
      citation != null &&
      typeof citation === "object" &&
      typeof (citation as Citation).id === "string" &&
      typeof (citation as Citation).title === "string" &&
      typeof (citation as Citation).url === "string",
  );
}
