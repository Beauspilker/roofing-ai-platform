import {
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_REALTIME_VOICE,
  isRealtimeBargeInEnabled,
} from "../../../lib/twilio/voice-mode.js";

export function getConfig() {
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const signingSecret = process.env.REALTIME_BRIDGE_SIGNING_SECRET?.trim() ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const supabaseServiceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

  return {
    port: Number.parseInt(process.env.PORT ?? "8080", 10),
    mediaPath: process.env.REALTIME_MEDIA_PATH?.trim() || "/media",
    openAiApiKey,
    openAiRealtimeModel:
      process.env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_OPENAI_REALTIME_MODEL,
    openAiRealtimeVoice:
      process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_OPENAI_REALTIME_VOICE,
    signingSecret,
    supabaseUrl,
    supabaseServiceRoleKey,
    maxCallDurationSeconds: Number.parseInt(
      process.env.MAX_CALL_DURATION_SECONDS ?? "900",
      10,
    ),
    bargeInEnabled: isRealtimeBargeInEnabled(),
  };
}

export type BridgeConfig = ReturnType<typeof getConfig>;

export function assertBridgeConfig(config: BridgeConfig): void {
  const missing: string[] = [];

  if (!config.openAiApiKey) {
    missing.push("OPENAI_API_KEY");
  }

  if (!config.signingSecret) {
    missing.push("REALTIME_BRIDGE_SIGNING_SECRET");
  }

  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }

  if (missing.length > 0) {
    throw new Error(`Bridge missing required env: ${missing.join(", ")}`);
  }
}
