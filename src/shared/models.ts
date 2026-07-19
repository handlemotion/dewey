export const MODELS = {
  deweyRealtime: "gpt-realtime-2.1",
  realtimeTranscription: "gpt-realtime-whisper",
  malcolm: "gpt-5.6-terra",
} as const;

export const AUDIO_PRICING_USD_PER_MINUTE = {
  "gpt-realtime-whisper": 0.017,
} as const;

export const MODEL_PRICING_USD_PER_MILLION = {
  "gpt-realtime-2.1": {
    audioInput: 32,
    audioCachedInput: 0.4,
    audioOutput: 64,
    textInput: 4,
    textCachedInput: 0.4,
    textOutput: 24,
  },
  "gpt-5.6-terra": {
    input: 2.5,
    cachedInput: 0.25,
    cacheWrite: 3.125,
    output: 15,
  },
} as const;

export const REASONING_EFFORT = {
  focused: "low",
  deep: "medium",
  maximum: "max",
} as const;
