/**
 * Feature flag for OpenAI Realtime voice via Twilio Media Streams.
 * Default (false or missing): legacy <Say>/<Gather> path.
 */
export const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview";

/** Professional male Realtime voice used when OPENAI_REALTIME_VOICE is unset. */
export const DEFAULT_OPENAI_REALTIME_VOICE = "cedar";

/** Male OpenAI Realtime voices accepted by the bridge (pass via OPENAI_REALTIME_VOICE). */
export const OPENAI_REALTIME_MALE_VOICES = ["cedar", "echo", "ash", "ballad"] as const;

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
  return process.env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_OPENAI_REALTIME_MODEL;
}

export function getOpenAiRealtimeVoice(): string {
  return process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_OPENAI_REALTIME_VOICE;
}

export function isRealtimeBargeInEnabled(): boolean {
  const value = process.env.REALTIME_BARGE_IN_ENABLED?.trim().toLowerCase();

  if (!value) {
    return true;
  }

  return value === "true";
}
