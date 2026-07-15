/**
 * Feature flag for OpenAI Realtime voice via Twilio Media Streams.
 * Default (false or missing): legacy <Say>/<Gather> path.
 */
export function isRealtimeVoiceEnabled(): boolean {
  return process.env.REALTIME_VOICE_ENABLED?.trim().toLowerCase() === "true";
}

export function getRealtimeWebSocketUrl(): string | null {
  const url = process.env.REALTIME_WEBSOCKET_URL?.trim();
  return url || null;
}

export function isRealtimeVoiceConfigured(): boolean {
  if (!isRealtimeVoiceEnabled()) {
    return false;
  }

  const url = getRealtimeWebSocketUrl();
  return Boolean(url && (url.startsWith("wss://") || url.startsWith("ws://")));
}

export function getOpenAiRealtimeModel(): string {
  return (
    process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-4o-realtime-preview"
  );
}

export function getOpenAiRealtimeVoice(): string {
  return process.env.OPENAI_REALTIME_VOICE?.trim() || "alloy";
}
