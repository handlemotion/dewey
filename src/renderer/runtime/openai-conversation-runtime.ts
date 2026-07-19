import { openai } from "@ai-sdk/openai";
import type {
  Experimental_RealtimeClientEvent,
  Experimental_RealtimeModel,
  Experimental_RealtimeServerEvent,
} from "ai";
import type {
  Citation,
  ConversationContextInput,
  ConversationRuntime,
  ConversationRuntimeEvent,
  ConversationRuntimeListener,
  ToolResult,
} from "../../shared/contracts";
import {
  AUDIO_PRICING_USD_PER_MINUTE,
  MODEL_PRICING_USD_PER_MILLION,
  MODELS,
} from "../../shared/models";

type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export class OpenAIConversationRuntime implements ConversationRuntime {
  private readonly model: Experimental_RealtimeModel;
  private readonly listeners = new Set<ConversationRuntimeListener>();
  private readonly outputSources = new Set<AudioBufferSourceNode>();
  private readonly transcriptByItem = new Map<string, string>();
  private readonly messageIdByItem = new Map<string, string>();
  private readonly finalizedItems = new Set<string>();
  private readonly finalizedInputItems = new Set<string>();
  private readonly toolCallsByResponse = new Map<string, Set<string>>();
  private readonly completedToolCalls = new Set<string>();
  private readonly handledToolCalls = new Set<string>();
  private readonly closedToolResponses = new Set<string>();
  private pendingCitations: Citation[] = [];
  private eventQueue: Promise<void> = Promise.resolve();
  private connectPromise: Promise<void> | undefined;
  private playback: { itemId: string; startedAt: number; scheduledThrough: number } | undefined;
  private socket: WebSocket | undefined;
  private mediaStream: MediaStream | undefined;
  private inputContext: AudioContext | undefined;
  private outputContext: AudioContextWithSink | undefined;
  private inputSource: MediaStreamAudioSourceNode | undefined;
  private processor: ScriptProcessorNode | undefined;
  private nextPlaybackAt = 0;
  private inputDeviceId = "default";
  private outputDeviceId = "default";
  private capturing = false;
  private lastInputLevelAt = 0;

  constructor(private readonly handsFree: boolean) {
    this.model = openai.experimental_realtime(MODELS.deweyRealtime);
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise != null) return this.connectPromise;
    const pending = this.openConnection();
    this.connectPromise = pending;
    try {
      await pending;
    } catch (error) {
      this.emit({
        type: "status",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (this.connectPromise === pending) this.connectPromise = undefined;
    }
  }

  private async openConnection(): Promise<void> {
    this.resetSessionState();
    this.emit({ type: "status", status: "connecting" });
    const credential = await window.dewey.createRealtimeSession();
    const config = this.model.getWebSocketConfig({
      token: credential.token,
      url: credential.url,
    });

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(config.url, config.protocols);
      this.socket = socket;
      let opened = false;
      const timeoutId = window.setTimeout(() => {
        if (opened) return;
        if (this.socket === socket) this.socket = undefined;
        socket.close();
        reject(new Error("Realtime connection timed out."));
      }, 15_000);
      socket.addEventListener("open", () => {
        if (this.socket !== socket) {
          window.clearTimeout(timeoutId);
          socket.close();
          reject(new Error("Realtime connection was superseded."));
          return;
        }
        opened = true;
        window.clearTimeout(timeoutId);
        this.send({
          type: "session-update",
          config: {
            tools: credential.tools,
            voice: "marin",
            outputModalities: ["audio"],
            inputAudioFormat: { type: "audio/pcm", rate: 24_000 },
            outputAudioFormat: { type: "audio/pcm", rate: 24_000 },
            inputAudioTranscription: {},
            turnDetection: this.handsFree ? { type: "semantic-vad" } : { type: "disabled" },
            providerOptions: { reasoning: { effort: "low" } },
          },
        });
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(event, socket));
      socket.addEventListener("close", () => {
        window.clearTimeout(timeoutId);
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.stopCapture();
        this.stopPlayback();
        this.emit({ type: "status", status: "idle" });
        if (!opened) reject(new Error("Realtime connection closed before it was ready."));
      });
      socket.addEventListener("error", () => {
        window.clearTimeout(timeoutId);
        if (this.socket !== socket) return;
        const error = new Error("Realtime connection failed.");
        this.emit({ type: "status", status: "error", message: error.message });
        if (!opened) reject(error);
      });
    });

    this.emit({ type: "status", status: "connected" });
    if (this.handsFree) await this.startUserTurn();
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.stopCapture();
    this.stopPlayback();
    socket?.close();
    this.resetSessionState();
    this.emit({ type: "status", status: "idle" });
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.inputDeviceId = deviceId || "default";
    if (this.capturing) {
      this.stopCapture();
      await this.startCapture();
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId || "default";
    if (this.outputContext?.setSinkId != null) {
      await this.outputContext.setSinkId(this.outputDeviceId);
    }
  }

  async startUserTurn(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) await this.connect();
    if (!this.capturing) await this.startCapture();
    this.emit({ type: "status", status: "listening" });
  }

  async endUserTurn(): Promise<void> {
    if (!this.handsFree) {
      this.stopCapture();
      this.send({ type: "input-audio-commit" });
      this.send({ type: "response-create" });
      this.emit({ type: "status", status: "connected" });
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    if (muted) {
      this.stopCapture();
      this.emit({ type: "status", status: "connected" });
      return;
    }
    await this.startUserTurn();
  }

  async interrupt(): Promise<void> {
    const truncation = this.currentPlaybackPosition();
    this.stopPlayback();
    this.send({ type: "response-cancel" });
    if (truncation != null) {
      this.send({
        type: "conversation-item-truncate",
        itemId: truncation.itemId,
        contentIndex: 0,
        audioEndMs: truncation.audioEndMs,
      });
    }
    this.emit({
      type: "status",
      status: this.capturing ? "listening" : "connected",
    });
  }

  async sendContext(input: ConversationContextInput): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) await this.connect();
    if (input.role === "system") {
      this.send({
        type: "response-create",
        options: { instructions: input.text, modalities: ["audio"] },
      });
      return;
    }
    this.send({
      type: "conversation-item-create",
      item: { type: "text-message", role: "user", text: input.text },
    });
    const messageId = crypto.randomUUID();
    await this.persistTranscript("user", input.text, messageId);
    this.emit({
      type: "transcript",
      role: "user",
      text: input.text,
      partial: false,
      messageId,
    });
    this.send({ type: "response-create" });
  }

  async submitToolResult(result: ToolResult): Promise<void> {
    this.sendToolOutput(result);
    this.send({ type: "response-create" });
  }

  private sendToolOutput(result: ToolResult): void {
    this.send({
      type: "conversation-item-create",
      item: {
        type: "function-call-output",
        callId: result.callId,
        output: JSON.stringify(result.output),
      },
    });
  }

  subscribe(listener: ConversationRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async startCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio:
        this.inputDeviceId === "default"
          ? true
          : {
              deviceId: { exact: this.inputDeviceId },
              autoGainControl: true,
              echoCancellation: true,
              noiseSuppression: true,
            },
    });
    this.inputContext = new AudioContext({ sampleRate: 24_000 });
    this.inputSource = this.inputContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.inputContext.createScriptProcessor(2_048, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.capturing) return;
      const samples = event.inputBuffer.getChannelData(0);
      const now = performance.now();
      if (now - this.lastInputLevelAt >= 80) {
        this.lastInputLevelAt = now;
        this.emit({ type: "input-level", level: rootMeanSquare(samples) });
      }
      const pcm = encodePcm16(samples);
      this.send({ type: "input-audio-append", audio: pcm });
    };
    this.inputSource.connect(this.processor);
    this.processor.connect(this.inputContext.destination);
    this.capturing = true;
  }

  private stopCapture(): void {
    this.capturing = false;
    this.processor?.disconnect();
    this.inputSource?.disconnect();
    for (const track of this.mediaStream?.getTracks() ?? []) track.stop();
    void this.inputContext?.close();
    this.processor = undefined;
    this.inputSource = undefined;
    this.mediaStream = undefined;
    this.inputContext = undefined;
    this.emit({ type: "input-level", level: 0 });
  }

  private async playAudio(itemId: string, base64: string, socket: WebSocket): Promise<void> {
    if (this.socket !== socket) return;
    if (this.outputContext == null) {
      this.outputContext = new AudioContext({ sampleRate: 24_000 }) as AudioContextWithSink;
      if (this.outputContext.setSinkId != null && this.outputDeviceId !== "default") {
        await this.outputContext.setSinkId(this.outputDeviceId);
      }
    }
    if (this.socket !== socket) return;
    const samples = decodePcm16(base64);
    const buffer = this.outputContext.createBuffer(1, samples.length, 24_000);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.outputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputContext.destination);
    this.outputSources.add(source);
    source.onended = () => {
      this.outputSources.delete(source);
      if (this.outputSources.size === 0) {
        this.emit({
          type: "status",
          status: this.capturing ? "listening" : "connected",
        });
      }
    };
    const now = this.outputContext.currentTime;
    const startAt = Math.max(now, this.nextPlaybackAt);
    source.start(startAt);
    this.nextPlaybackAt = startAt + buffer.duration;
    if (this.playback?.itemId === itemId) {
      this.playback.scheduledThrough = this.nextPlaybackAt;
    } else {
      this.playback = {
        itemId,
        startedAt: startAt,
        scheduledThrough: this.nextPlaybackAt,
      };
    }
    this.emit({ type: "status", status: "speaking" });
  }

  private stopPlayback(): void {
    for (const source of this.outputSources) {
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
    }
    this.outputSources.clear();
    this.nextPlaybackAt = 0;
    this.playback = undefined;
  }

  private handleMessage(message: MessageEvent, socket: WebSocket): void {
    try {
      const normalized = this.model.parseServerEvent(JSON.parse(String(message.data)));
      for (const event of Array.isArray(normalized) ? normalized : [normalized]) {
        this.eventQueue = this.eventQueue
          .then(async () => {
            if (this.socket !== socket) return;
            await this.handleEvent(event, socket);
          })
          .catch((error: unknown) => {
            if (this.socket !== socket) return;
            this.emit({
              type: "status",
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }
    } catch (error) {
      this.emit({
        type: "status",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleEvent(
    event: Experimental_RealtimeServerEvent,
    socket: WebSocket,
  ): Promise<void> {
    switch (event.type) {
      case "session-created":
      case "session-updated":
        this.emit({ type: "status", status: "connected" });
        break;
      case "speech-started":
        if (this.outputSources.size > 0) await this.interrupt();
        this.emit({ type: "status", status: "listening" });
        break;
      case "input-transcription-completed":
        {
          if (this.finalizedInputItems.has(event.itemId)) break;
          this.finalizedInputItems.add(event.itemId);
          if (this.finalizedInputItems.size > 500) this.finalizedInputItems.clear();
          const messageId = this.messageIdForItem(event.itemId);
          this.emit({
            type: "transcript",
            role: "user",
            text: event.transcript,
            partial: false,
            messageId,
          });
          await this.persistTranscript("user", event.transcript, messageId);
          await this.emitTranscriptionUsage(event.raw);
          this.messageIdByItem.delete(event.itemId);
        }
        break;
      case "audio-delta":
        await this.playAudio(event.itemId, event.delta, socket);
        break;
      case "audio-transcript-delta":
      case "text-delta": {
        const text = `${this.transcriptByItem.get(event.itemId) ?? ""}${event.delta}`;
        this.transcriptByItem.set(event.itemId, text);
        this.emit({
          type: "transcript",
          role: "dewey",
          text,
          partial: true,
          messageId: this.messageIdForItem(event.itemId),
        });
        break;
      }
      case "audio-transcript-done":
      case "text-done": {
        if (this.finalizedItems.has(event.itemId)) break;
        const text =
          event.type === "audio-transcript-done"
            ? (event.transcript ?? this.transcriptByItem.get(event.itemId) ?? "")
            : (event.text ?? this.transcriptByItem.get(event.itemId) ?? "");
        if (text.trim().length === 0) break;
        this.finalizedItems.add(event.itemId);
        if (this.finalizedItems.size > 500) this.finalizedItems.clear();
        this.transcriptByItem.delete(event.itemId);
        const messageId = this.messageIdForItem(event.itemId);
        const citations = this.takePendingCitations();
        this.emit({
          type: "transcript",
          role: "dewey",
          text,
          partial: false,
          messageId,
          ...(citations.length === 0 ? {} : { citations }),
        });
        await this.persistTranscript("dewey", text, messageId, citations);
        this.messageIdByItem.delete(event.itemId);
        break;
      }
      case "function-call-arguments-done": {
        if (this.handledToolCalls.has(event.callId)) break;
        this.handledToolCalls.add(event.callId);
        if (this.handledToolCalls.size > 500) this.handledToolCalls.clear();
        const responseCalls = this.toolCallsByResponse.get(event.responseId) ?? new Set<string>();
        responseCalls.add(event.callId);
        this.toolCallsByResponse.set(event.responseId, responseCalls);
        const args = safeJson(event.arguments);
        this.emit({
          type: "tool-call",
          callId: event.callId,
          toolName: event.name,
          arguments: args,
        });
        let output: unknown;
        try {
          output = await window.dewey.executeRealtimeTool({
            callId: event.callId,
            toolName: event.name,
            arguments: args,
          });
          if (this.socket !== socket) return;
          this.pendingCitations = mergeCitations(this.pendingCitations, readCitations(output));
        } catch (error) {
          if (this.socket !== socket) return;
          output = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        this.emit({
          type: "tool-result",
          callId: event.callId,
          toolName: event.name,
          output,
        });
        this.sendToolOutput({ callId: event.callId, output });
        this.completedToolCalls.add(event.callId);
        this.maybeRequestToolFollowup(event.responseId);
        break;
      }
      case "response-done":
        this.closedToolResponses.add(event.responseId);
        this.maybeRequestToolFollowup(event.responseId);
        await this.emitUsage(event.raw);
        break;
      case "error":
        this.emit({ type: "status", status: "error", message: event.message });
        break;
    }
  }

  private async emitUsage(raw: unknown): Promise<void> {
    const usage = (raw as { response?: { usage?: Record<string, unknown> } }).response?.usage;
    if (usage == null) return;
    const inputTokens = numberField(usage, "input_tokens");
    const outputTokens = numberField(usage, "output_tokens");
    const inputDetails = recordField(usage, "input_token_details");
    const outputDetails = recordField(usage, "output_token_details");
    const audioInputTokens = numberField(inputDetails, "audio_tokens");
    const audioOutputTokens = numberField(outputDetails, "audio_tokens");
    const cachedInputTokens = numberField(inputDetails, "cached_tokens");
    const cachedDetails = recordField(inputDetails, "cached_tokens_details");
    const cachedAudioInputTokens = numberField(cachedDetails, "audio_tokens");
    const cachedTextInputTokens = Math.max(0, cachedInputTokens - cachedAudioInputTokens);
    const textInputTokens = Math.max(0, inputTokens - audioInputTokens);
    const textOutputTokens = Math.max(0, outputTokens - audioOutputTokens);
    const pricing = MODEL_PRICING_USD_PER_MILLION[MODELS.deweyRealtime];
    const estimatedCostUsd =
      (Math.max(0, textInputTokens - cachedTextInputTokens) * pricing.textInput +
        cachedTextInputTokens * pricing.textCachedInput +
        Math.max(0, audioInputTokens - cachedAudioInputTokens) * pricing.audioInput +
        cachedAudioInputTokens * pricing.audioCachedInput +
        textOutputTokens * pricing.textOutput +
        audioOutputTokens * pricing.audioOutput) /
      1_000_000;
    const event = {
      type: "usage" as const,
      inputTokens,
      outputTokens,
      audioInputTokens,
      audioOutputTokens,
      cachedInputTokens,
      estimatedCostUsd,
    };
    this.emit(event);
    await window.dewey.recordRealtimeUsage({
      model: MODELS.deweyRealtime,
      inputTokens,
      outputTokens,
      audioInputTokens,
      audioOutputTokens,
      cachedInputTokens,
      estimatedCostUsd,
    });
  }

  private async emitTranscriptionUsage(raw: unknown): Promise<void> {
    const usage = (raw as { usage?: Record<string, unknown> }).usage;
    if (usage == null) return;
    const inputTokens = numberField(usage, "input_tokens");
    const outputTokens = numberField(usage, "output_tokens");
    const inputDetails = recordField(usage, "input_token_details");
    const audioInputTokens = numberField(inputDetails, "audio_tokens");
    const estimatedCostUsd =
      (audioInputTokens / 600) * AUDIO_PRICING_USD_PER_MINUTE[MODELS.realtimeTranscription];
    this.emit({
      type: "usage",
      inputTokens,
      outputTokens,
      audioInputTokens,
      audioOutputTokens: 0,
      cachedInputTokens: 0,
      estimatedCostUsd,
    });
    await window.dewey.recordRealtimeUsage({
      model: MODELS.realtimeTranscription,
      inputTokens,
      outputTokens,
      audioInputTokens,
      audioOutputTokens: 0,
      cachedInputTokens: 0,
      estimatedCostUsd,
    });
  }

  private async persistTranscript(
    role: "user" | "dewey",
    text: string,
    id: string,
    citations: Citation[] = [],
  ): Promise<void> {
    if (text.trim().length === 0) return;
    await window.dewey.recordMessage({
      id,
      role,
      text: text.trim(),
      createdAt: new Date().toISOString(),
      ...(citations.length === 0 ? {} : { citations }),
    });
  }

  private messageIdForItem(itemId: string): string {
    const existing = this.messageIdByItem.get(itemId);
    if (existing != null) return existing;
    const created = crypto.randomUUID();
    this.messageIdByItem.set(itemId, created);
    return created;
  }

  private currentPlaybackPosition(): { itemId: string; audioEndMs: number } | undefined {
    if (this.outputContext == null || this.playback == null) return undefined;
    const playedThrough = Math.min(this.outputContext.currentTime, this.playback.scheduledThrough);
    return {
      itemId: this.playback.itemId,
      audioEndMs: Math.max(0, Math.round((playedThrough - this.playback.startedAt) * 1_000)),
    };
  }

  private takePendingCitations(): Citation[] {
    const citations = this.pendingCitations;
    this.pendingCitations = [];
    return citations;
  }

  private maybeRequestToolFollowup(responseId: string): void {
    const calls = this.toolCallsByResponse.get(responseId);
    if (
      calls == null ||
      calls.size === 0 ||
      !this.closedToolResponses.has(responseId) ||
      [...calls].some((callId) => !this.completedToolCalls.has(callId))
    ) {
      return;
    }
    this.send({ type: "response-create" });
    for (const callId of calls) this.completedToolCalls.delete(callId);
    this.toolCallsByResponse.delete(responseId);
    this.closedToolResponses.delete(responseId);
  }

  private send(event: Experimental_RealtimeClientEvent): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(this.model.serializeClientEvent(event)));
  }

  private resetSessionState(): void {
    this.transcriptByItem.clear();
    this.messageIdByItem.clear();
    this.finalizedItems.clear();
    this.finalizedInputItems.clear();
    this.toolCallsByResponse.clear();
    this.completedToolCalls.clear();
    this.handledToolCalls.clear();
    this.closedToolResponses.clear();
    this.pendingCitations = [];
    this.eventQueue = Promise.resolve();
  }

  private emit(event: ConversationRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function encodePcm16(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytesToBase64(bytes);
}

function rootMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
}

function decodePcm16(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const view = new DataView(buffer);
  const samples = new Float32Array(binary.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function numberField(record: Record<string, unknown>, key: string): number {
  return typeof record[key] === "number" ? record[key] : 0;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readCitations(value: unknown): Citation[] {
  if (value == null || typeof value !== "object" || !("citations" in value)) return [];
  if (!Array.isArray(value.citations)) return [];
  return value.citations.filter(
    (citation): citation is Citation =>
      citation != null &&
      typeof citation === "object" &&
      typeof citation.id === "string" &&
      typeof citation.title === "string" &&
      typeof citation.url === "string",
  );
}

function mergeCitations(existing: Citation[], incoming: Citation[]): Citation[] {
  const merged = new Map(existing.map((citation) => [citation.url, citation]));
  for (const citation of incoming) merged.set(citation.url, citation);
  return [...merged.values()].slice(0, 20);
}
