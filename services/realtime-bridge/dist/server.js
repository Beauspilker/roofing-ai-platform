// src/server.ts
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

// ../../lib/twilio/voice-mode.ts
var DEFAULT_OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview";
var DEFAULT_OPENAI_REALTIME_VOICE = "cedar";
function isRealtimeBargeInEnabled() {
  const value = process.env.REALTIME_BARGE_IN_ENABLED?.trim().toLowerCase();
  if (!value) {
    return true;
  }
  return value === "true";
}

// src/config.ts
function getConfig() {
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const signingSecret = process.env.REALTIME_BRIDGE_SIGNING_SECRET?.trim() ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  return {
    port: Number.parseInt(process.env.PORT ?? "8080", 10),
    mediaPath: process.env.REALTIME_MEDIA_PATH?.trim() || "/media",
    openAiApiKey,
    openAiRealtimeModel: process.env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_OPENAI_REALTIME_MODEL,
    openAiRealtimeVoice: process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_OPENAI_REALTIME_VOICE,
    signingSecret,
    supabaseUrl,
    supabaseServiceRoleKey,
    maxCallDurationSeconds: Number.parseInt(
      process.env.MAX_CALL_DURATION_SECONDS ?? "900",
      10
    ),
    bargeInEnabled: isRealtimeBargeInEnabled(),
    turnDetectionSilenceDurationMs: Number.parseInt(
      process.env.REALTIME_SILENCE_DURATION_MS ?? "600",
      10
    ),
    turnDetectionPrefixPaddingMs: Number.parseInt(
      process.env.REALTIME_PREFIX_PADDING_MS ?? "250",
      10
    ),
    turnDetectionThreshold: Number.parseFloat(
      process.env.REALTIME_VAD_THRESHOLD ?? "0.5"
    ),
    realtimeVadEagerness: process.env.REALTIME_VAD_EAGERNESS?.trim() || "high",
    companyTimezone: process.env.COMPANY_TIMEZONE?.trim() || "America/Chicago"
  };
}
function assertBridgeConfig(config2) {
  const missing = [];
  if (!config2.openAiApiKey) {
    missing.push("OPENAI_API_KEY");
  }
  if (!config2.signingSecret) {
    missing.push("REALTIME_BRIDGE_SIGNING_SECRET");
  }
  if (!config2.supabaseUrl || !config2.supabaseServiceRoleKey) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  if (missing.length > 0) {
    throw new Error(`Bridge missing required env: ${missing.join(", ")}`);
  }
}

// src/auth/stream-token.ts
import { createHmac, timingSafeEqual } from "crypto";
var TOKEN_TTL_MS = 15 * 60 * 1e3;
function verifyStreamAuthToken(callSid, token, secret) {
  if (!secret || !callSid || !token) {
    return false;
  }
  const [expiresAtRaw, signature] = token.split(".");
  if (!expiresAtRaw || !signature) {
    return false;
  }
  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return false;
  }
  const payload = `${callSid}:${expiresAt}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const providedBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

// src/logger.ts
function sanitizeFields(fields) {
  const sanitized = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === void 0) {
      continue;
    }
    if (key.toLowerCase().includes("token") || key.toLowerCase().includes("secret")) {
      sanitized[key] = "[redacted]";
      continue;
    }
    if (key === "callSid" && typeof value === "string" && value.length > 8) {
      sanitized[key] = `${value.slice(0, 4)}...${value.slice(-4)}`;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
function logInfo(event, fields = {}) {
  console.info(JSON.stringify({ level: "info", event, ...sanitizeFields(fields) }));
}
function logWarn(event, fields = {}) {
  console.warn(JSON.stringify({ level: "warn", event, ...sanitizeFields(fields) }));
}
function logError(event, fields = {}, error) {
  const message = error instanceof Error ? error.message : error ? String(error) : void 0;
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...sanitizeFields(fields),
      ...message ? { errorMessage: message } : {}
    })
  );
}

// src/twilio/messages.ts
function parseTwilioStreamEvent(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("event" in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function buildTwilioMediaMessage(streamSid, payload) {
  return {
    event: "media",
    streamSid,
    media: { payload }
  };
}
function buildTwilioClearMessage(streamSid) {
  return {
    event: "clear",
    streamSid
  };
}
function buildTwilioMarkMessage(streamSid, name) {
  return {
    event: "mark",
    streamSid,
    mark: { name }
  };
}

// src/bridge/barge-in.ts
var BargeInController = class {
  constructor(options) {
    this.options = options;
  }
  assistantSpeaking = false;
  activeResponseId = null;
  activeItemId = null;
  bargeInCount = 0;
  setAssistantSpeaking(speaking) {
    this.assistantSpeaking = speaking;
    this.options.onAssistantSpeakingChange(speaking);
  }
  isAssistantSpeaking() {
    return this.assistantSpeaking;
  }
  setActiveResponse(responseId, itemId) {
    this.activeResponseId = responseId;
    this.activeItemId = itemId;
  }
  handleCallerSpeechStarted() {
    if (!this.options.enabled || !this.assistantSpeaking) {
      return;
    }
    const responseId = this.activeResponseId ?? this.options.getActiveResponseId();
    const itemId = this.activeItemId ?? this.options.getActiveItemId();
    const streamSid = this.options.getStreamSid();
    logInfo("barge_in_triggered", {
      responseId: responseId ?? void 0,
      bargeInCount: this.bargeInCount + 1
    });
    this.bargeInCount += 1;
    if (responseId) {
      this.options.sendOpenAiEvent({
        type: "response.cancel",
        response_id: responseId
      });
    } else {
      this.options.sendOpenAiEvent({ type: "response.cancel" });
    }
    if (itemId) {
      this.options.sendOpenAiEvent({
        type: "conversation.item.truncate",
        item_id: itemId,
        content_index: 0,
        audio_end_ms: this.options.getPlayedDurationMs()
      });
    }
    if (streamSid) {
      this.options.sendTwilioMessage(
        buildTwilioClearMessage(streamSid)
      );
    }
    this.setAssistantSpeaking(false);
    this.activeResponseId = null;
  }
  handleResponseCancelled() {
    logInfo("response_cancelled");
    this.setAssistantSpeaking(false);
    this.activeResponseId = null;
  }
  handleResponseCompleted() {
    logInfo("response_completed");
    this.setAssistantSpeaking(false);
    this.activeResponseId = null;
  }
  handleResponseStarted(responseId, itemId) {
    logInfo("response_started", { responseId });
    this.activeResponseId = responseId;
    this.activeItemId = itemId;
    this.setAssistantSpeaking(true);
  }
};

// src/bridge/call-timing.ts
var CallTimingTracker = class {
  startedAt = Date.now();
  marks = /* @__PURE__ */ new Map();
  record(milestone, callSid) {
    if (this.marks.has(milestone)) {
      return;
    }
    const now = Date.now();
    this.marks.set(milestone, now);
    logInfo("call_timing", {
      callSid,
      milestone,
      elapsedMs: now - this.startedAt,
      sinceTwilioStartedMs: this.delta("twilio_stream_started", milestone),
      sinceOpenAiConnectedMs: this.delta("openai_connected", milestone),
      sinceSessionReadyMs: this.delta("openai_session_ready", milestone)
    });
  }
  delta(from, to) {
    const fromMs = this.marks.get(from);
    const toMs = this.marks.get(to);
    if (fromMs === void 0 || toMs === void 0) {
      return void 0;
    }
    return toMs - fromMs;
  }
};

// src/bridge/turn-timing.ts
var TurnTimingTracker = class {
  turnStartedAt = null;
  turnId = null;
  marks = /* @__PURE__ */ new Map();
  stageTotals = /* @__PURE__ */ new Map();
  beginTurn(callSid, turnId) {
    this.turnStartedAt = Date.now();
    this.turnId = turnId ?? null;
    this.marks.clear();
    logInfo("turn_timing_reset", { callSid, turnId });
  }
  getTurnId() {
    return this.turnId;
  }
  isStaleTurn(turnId) {
    if (turnId === null || turnId === void 0 || this.turnId === null) {
      return false;
    }
    return turnId !== this.turnId;
  }
  hasFirstAudio() {
    return this.marks.has("first_audio_received");
  }
  record(milestone, callSid, options = {}) {
    if (this.isStaleTurn(options.turnId)) {
      return;
    }
    if (this.turnStartedAt === null) {
      this.beginTurn(callSid, options.turnId ?? void 0);
    }
    if (this.marks.has(milestone)) {
      return;
    }
    const now = Date.now();
    this.marks.set(milestone, now);
    const speechStopped = this.marks.get("speech_stopped");
    logInfo("turn_timing", {
      callSid,
      turnId: this.turnId,
      milestone,
      elapsedMs: now - (this.turnStartedAt ?? now),
      elapsedFromSpeechStoppedMs: speechStopped !== void 0 ? now - speechStopped : void 0,
      caller_speech_stopped_at: this.marks.get("speech_stopped"),
      final_transcript_at: this.marks.get("transcript_completed"),
      caller_turn_processed_at: this.marks.get("caller_turn_processed"),
      state_updated_at: this.marks.get("structured_state_updated"),
      next_question_selected_at: this.marks.get("next_question_selected"),
      response_requested_at: this.marks.get("response_requested"),
      response_create_sent_at: this.marks.get("response_create_sent"),
      first_audio_delta_at: this.marks.get("first_audio_received"),
      first_audio_sent_to_twilio_at: this.marks.get("first_audio_sent_to_twilio")
    });
    if (milestone === "first_audio_sent_to_twilio") {
      this.recordStageSegments(callSid);
    }
  }
  recordStageSegments(callSid) {
    const speechStopped = this.marks.get("speech_stopped");
    const transcriptCompleted = this.marks.get("transcript_completed");
    const callerTurnProcessed = this.marks.get("caller_turn_processed");
    const structuredUpdated = this.marks.get("structured_state_updated");
    const responseRequested = this.marks.get("response_requested");
    const responseCreateSent = this.marks.get("response_create_sent");
    const firstReceived = this.marks.get("first_audio_received");
    const firstSent = this.marks.get("first_audio_sent_to_twilio");
    if (speechStopped === void 0 || transcriptCompleted === void 0 || callerTurnProcessed === void 0 || structuredUpdated === void 0 || responseRequested === void 0 || responseCreateSent === void 0 || firstReceived === void 0 || firstSent === void 0) {
      return;
    }
    const segments = [
      { stage: "speech_stopped_to_transcript", ms: transcriptCompleted - speechStopped },
      { stage: "transcript_to_turn_processed", ms: callerTurnProcessed - transcriptCompleted },
      { stage: "turn_processed_to_state_updated", ms: structuredUpdated - callerTurnProcessed },
      { stage: "state_updated_to_response_requested", ms: responseRequested - structuredUpdated },
      { stage: "response_requested_to_create_sent", ms: responseCreateSent - responseRequested },
      { stage: "response_create_to_first_audio", ms: firstReceived - responseCreateSent },
      { stage: "first_audio_to_twilio_send", ms: firstSent - firstReceived }
    ];
    for (const segment of segments) {
      const existing = this.stageTotals.get(segment.stage) ?? { totalMs: 0, count: 0 };
      this.stageTotals.set(segment.stage, {
        totalMs: existing.totalMs + segment.ms,
        count: existing.count + 1
      });
    }
    const speechStoppedToFirstAudioMs = firstReceived - speechStopped;
    logInfo("turn_timing_summary", {
      callSid,
      turnId: this.turnId,
      speechStoppedToFirstAudioMs,
      speechStoppedToTranscriptMs: transcriptCompleted - speechStopped,
      transcriptToResponseCreateMs: responseCreateSent - transcriptCompleted,
      responseCreateToFirstAudioMs: firstReceived - responseCreateSent,
      stageAveragesMs: this.getStageAveragesMs()
    });
  }
  getStageAveragesMs() {
    return Object.fromEntries(
      [...this.stageTotals.entries()].map(([stage, stats]) => [
        stage,
        Math.round(stats.totalMs / stats.count)
      ])
    );
  }
  getSpeechStoppedToFirstAudioMs() {
    const speechStopped = this.marks.get("speech_stopped");
    const firstReceived = this.marks.get("first_audio_received");
    if (speechStopped === void 0 || firstReceived === void 0) {
      return void 0;
    }
    return firstReceived - speechStopped;
  }
};

// ../../lib/twilio/company-phone.ts
var DEFAULT_COMPANY_PHONE_E164 = "+14027611540";
function getCompanyPhoneE164() {
  return process.env.TWILIO_PHONE_NUMBER?.trim() || DEFAULT_COMPANY_PHONE_E164;
}

// src/orchestrator/callback-phone.ts
function normalizeCallbackPhoneE164(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (phone.trim().startsWith("+") && digits.length >= 10) {
    return `+${digits}`;
  }
  return phone.trim();
}
function formatCallbackForSpeech(phone) {
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    return phone.trim();
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}
function isCompanyPhoneNumber(phone) {
  const normalized = normalizeCallbackPhoneE164(phone);
  const company = normalizeCallbackPhoneE164(getCompanyPhoneE164());
  return normalized === company;
}
function buildCallbackReadbackConfirmation(phone) {
  const spoken = formatCallbackForSpeech(phone);
  return `I have your callback number as ${spoken}. Is that correct?`;
}
function isCallbackConfirmed(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|that's correct|thats correct|affirmative)\b/.test(
    normalized
  );
}
function isCallbackRejected(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}
function extractCallbackPhoneFromSpeech(speech, callerPhone, options = {}) {
  const normalized = speech.toLowerCase();
  const phonePattern = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g;
  const matches = [...speech.matchAll(phonePattern)];
  if (matches.length > 0) {
    const hasCorrection = /\b(actually|make that|correction|instead|rather|change it to|should be)\b/i.test(
      speech
    );
    const chosen = hasCorrection ? matches[matches.length - 1] : matches[0];
    const digits = chosen[0].replace(/\D/g, "");
    if (digits.length >= 10) {
      const e164 = normalizeCallbackPhoneE164(digits.slice(-10));
      if (!isCompanyPhoneNumber(e164)) {
        return e164;
      }
    }
  }
  if (options.allowAffirmativeReuse === true && callerPhone && /^(yes|yeah|yep|correct|this one|that one|same number|this number|calling from)\b/i.test(
    normalized.trim()
  )) {
    const e164 = normalizeCallbackPhoneE164(callerPhone);
    if (!isCompanyPhoneNumber(e164)) {
      return e164;
    }
  }
  return null;
}

// src/orchestrator/photos-field.ts
function normalizePhotosValue(value) {
  if (value === true || value === false || value === "unknown" || value === "declined") {
    return value;
  }
  if (value === "yes") {
    return true;
  }
  if (value === "no") {
    return false;
  }
  if (value === "unknown") {
    return "unknown";
  }
  if (value === "declined") {
    return "declined";
  }
  if (value === null || value === void 0) {
    return null;
  }
  return null;
}

// src/orchestrator/structured-intake.ts
var EXPLICIT_YES = /^(yes|yeah|yep|yup|sure|correct|right|already|i have|i did|i've|we have|we've)\b/i;
var EXPLICIT_NO = /^(no|nope|nah|not yet|haven't|havent|have not|none|negative|i haven't|i have not|we haven't|we have not)\b/i;
var NOT_YET = /\bnot yet\b/i;
function parseCorrectionBoolean(speech) {
  const normalized = speech.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/\b(not yet|haven't started|have not started|haven't|have not|no claim)\b/.test(
    normalized
  ) && !/\b(actually|wrong|incorrect|correction|did start|started a claim|have started)\b/.test(
    normalized
  )) {
    return false;
  }
  if (/\b(yes|yeah|yep|i did start|i have started|we started|already started|did start a claim|started a claim|started the claim)\b/.test(
    normalized
  )) {
    return true;
  }
  if (/^(no|nope|nah)\b/.test(normalized) && !/\b(wrong|incorrect|actually|correction)\b/.test(normalized)) {
    return false;
  }
  return parseExplicitBoolean(speech);
}
function parseExplicitBoolean(speech) {
  const normalized = speech.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (NOT_YET.test(normalized) || EXPLICIT_NO.test(normalized)) {
    return false;
  }
  if (EXPLICIT_YES.test(normalized)) {
    return true;
  }
  return null;
}
function isStructuredBooleanUnset(value) {
  return value === void 0 || value === null;
}
function syncLegacyStringFields(fields) {
  return { ...fields };
}
function toCollectedFields(fields) {
  return {
    ...fields,
    insurance_claim: triStateToLegacyString(fields.insurance_claim_started),
    adjuster_contacted: triStateToLegacyString(normalizeTriState(fields.adjuster_contacted)),
    photos_available: photosValueToLegacyString(normalizePhotosValue(fields.photos_available)),
    active_leak: triStateToLegacyString(fields.emergency_or_active_leak)
  };
}
function normalizeTriStateField(value) {
  return normalizeTriState(value);
}
function normalizeTriState(value) {
  if (value === true || value === false || value === null) {
    return value;
  }
  if (value === "yes") {
    return true;
  }
  if (value === "no") {
    return false;
  }
  return null;
}
function triStateToLegacyString(value) {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return void 0;
}
function photosValueToLegacyString(value) {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  if (value === "unknown") {
    return "unknown";
  }
  if (value === "declined") {
    return "declined";
  }
  return void 0;
}
function applyCorrectionToStructuredField(fields, speech) {
  let updated = { ...fields };
  const normalized = speech.toLowerCase();
  if (/insurance|claim/.test(normalized)) {
    const parsed = parseCorrectionBoolean(speech);
    if (parsed !== null) {
      updated.insurance_claim_started = parsed;
    }
  }
  if (/adjuster/.test(normalized)) {
    const parsed = parseCorrectionBoolean(speech);
    if (parsed !== null) {
      updated.adjuster_contacted = parsed;
    }
  }
  if (/photo|picture|image/.test(normalized)) {
    const parsed = parseCorrectionBoolean(speech);
    if (parsed !== null) {
      updated.photos_available = parsed;
    }
  }
  if (/leak|water|emergency|urgent/.test(normalized)) {
    const parsed = parseCorrectionBoolean(speech);
    if (parsed !== null) {
      updated.emergency_or_active_leak = parsed;
    }
  }
  return syncLegacyStringFields(updated);
}

// src/orchestrator/conversation-state.ts
var CLOSING_MESSAGE = "Great. I'll send this information to the roofing team, and someone will follow up with you by call or text. Thanks for calling Beau's Roofing. Have a great day.";

// src/orchestrator/field-validation.ts
var DAMAGE_AND_INTAKE_TERMS = /\b(hail(?:\s+damage)?|storm(?:\s+damage)?|roof(?:ing)?(?:\s+leak)?|roof\s+leak|leak(?:ing)?|missing\s+shingles?|shingles?|damage|damaged|insurance|claim|adjuster|estimate|inspection|replacement|pictures?|photos?|appointment|today|tomorrow|morning|afternoon|evening|urgent|emergency|water|tree(?:\s+damage)?|wind|gutter|repair|replace|callback|address|property|number|yes|no|yeah|nope|yep|nah|correct|right)\b/i;
var PHONE_PATTERN = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
var DATE_OR_TIME_PATTERN = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}\/\d{1,2})\b/i;
var NON_NAME_I_AM_LEAD_INS = /^(?:i'?m|i am)\s+(?:calling(?:\s+(?:about|for|regarding))?|call(?:ing)?\s+(?:about|for|regarding)|having|needing|looking(?:\s+for)?|wondering(?:\s+(?:about|if))?|trying(?:\s+to)?|reporting|asking(?:\s+about)?)\b/i;
var CALL_REASON_LEAD_IN_PATTERN = /\b(?:i'?m|i am|we'?re|we are)\s+(?:calling(?:\s+(?:about|for|regarding))?|call(?:ing)?\s+(?:about|for|regarding)|having|needing|looking(?:\s+for)?|wondering(?:\s+(?:about|if))?|trying(?:\s+to)?|reporting|asking(?:\s+about)?)\b/i;
var POSITIVE_NAME_INTRO_PATTERNS = [
  /\b(?:my name is|name is)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,3})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
  /\bthis is\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
  /\b(?:it'?s|it is)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
  /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,2})(?=\s*,\s*and\b)/i,
  /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+)?)(?=\s*,)/i,
  /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'\-]+)\s+and\b/i,
  /\b(?:call me)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i
];
var INVALID_CALLER_NAME_EXACT = /^(?:calling|call|calling about|calling for|having|needing|looking|wondering|trying|reporting|asking|roof|roofing|damage|hail|storm|leak|shingles|insurance|claim|pictures|photos|appointment|today|tomorrow|yes|no|yeah|nope|yep|nah|correct|right|and|with|from|who|about|for|the|this|that|it|its|i|i'm|im|am|are|we|our|my|your|have|has|had)$/i;
var INVALID_CALLER_NAME_VERB = /^(?:am|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|can|could|should|may|might|must|need|want|got|get|getting|going|looking|wondering|trying|reporting|asking|calling|having|needing)$/i;
function containsRoofingDamageLanguage(text) {
  return DAMAGE_AND_INTAKE_TERMS.test(text.trim());
}
function isNonNameIamLeadIn(speech) {
  return NON_NAME_I_AM_LEAD_INS.test(speech.trim());
}
function isCallReasonLeadInSpeech(speech) {
  return CALL_REASON_LEAD_IN_PATTERN.test(speech.trim());
}
function hasPositiveNameEvidence(speech) {
  const trimmed = speech.trim();
  if (!trimmed || isNonNameIamLeadIn(trimmed) || isCallReasonLeadInSpeech(trimmed)) {
    return false;
  }
  return POSITIVE_NAME_INTRO_PATTERNS.some((pattern) => pattern.test(trimmed));
}
function isLikelyCallReasonSpeech(speech) {
  const trimmed = speech.trim();
  if (!trimmed) {
    return false;
  }
  if (isCallReasonLeadInSpeech(trimmed)) {
    return true;
  }
  if (isPlausibleDamageDescription(trimmed)) {
    return true;
  }
  if (containsRoofingDamageLanguage(trimmed) && !hasPositiveNameEvidence(trimmed)) {
    return true;
  }
  return false;
}
function isOpeningReasonCaptureContext(fields, options = {}) {
  if (options.isFirstCallerTurn === true) {
    return true;
  }
  if (!fields.problem_description?.trim()) {
    return true;
  }
  return fields.pending_question?.trim() === "reason_for_call" || fields.pending_question?.trim() === "call_reason";
}
function tokenizeNameWords(name) {
  return name.trim().split(/\s+/).filter(Boolean);
}
function isInvalidCallerNameWord(word) {
  const normalized = word.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (INVALID_CALLER_NAME_EXACT.test(normalized)) {
    return true;
  }
  if (INVALID_CALLER_NAME_VERB.test(normalized)) {
    return true;
  }
  if (containsRoofingDamageLanguage(normalized)) {
    return true;
  }
  if (DATE_OR_TIME_PATTERN.test(normalized)) {
    return true;
  }
  return false;
}
function isPlausibleCallerName(name) {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 60) {
    return false;
  }
  if (/\d/.test(trimmed) || PHONE_PATTERN.test(trimmed)) {
    return false;
  }
  if (/[.!?]/.test(trimmed)) {
    return false;
  }
  const words = tokenizeNameWords(trimmed);
  if (words.length === 0 || words.length > 4) {
    return false;
  }
  if (words.some((word) => isInvalidCallerNameWord(word))) {
    return false;
  }
  if (INVALID_CALLER_NAME_EXACT.test(trimmed.replace(/\s+/g, " "))) {
    return false;
  }
  if (containsRoofingDamageLanguage(trimmed)) {
    return false;
  }
  if (DATE_OR_TIME_PATTERN.test(trimmed)) {
    return false;
  }
  if (isCallReasonLeadInSpeech(trimmed) || isNonNameIamLeadIn(trimmed)) {
    return false;
  }
  if (/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct)\b/i.test(
    trimmed
  )) {
    return false;
  }
  return /^[A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*){0,3}$/.test(trimmed);
}
function refineNameCandidate(candidate) {
  const words = candidate.trim().split(/\s+/).filter(Boolean);
  for (let length = words.length; length >= 1; length -= 1) {
    const prefix = words.slice(0, length).join(" ");
    if (isPlausibleCallerName(prefix)) {
      return prefix;
    }
  }
  return null;
}
function extractExplicitCallerName(speech) {
  const trimmed = speech.trim();
  if (!trimmed || isNonNameIamLeadIn(trimmed)) {
    return null;
  }
  for (const pattern of POSITIVE_NAME_INTRO_PATTERNS) {
    const match = trimmed.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate) {
      continue;
    }
    const refined = refineNameCandidate(candidate);
    if (refined) {
      return refined;
    }
  }
  return null;
}
function validateCallerNameCandidate(speech, options = {}) {
  const trimmed = speech.trim();
  if (!trimmed) {
    return { value: null, needsClarification: false };
  }
  const explicit = extractExplicitCallerName(trimmed);
  if (explicit) {
    return { value: explicit, needsClarification: false };
  }
  if (options.isDirectNameAnswer || options.allowDirectNameWithoutIntro) {
    const directCandidate = trimmed.replace(/^(?:it'?s|it is)\s+/i, "").replace(/[.!?]+$/g, "").trim();
    if (isLikelyCallReasonSpeech(directCandidate) || isCallReasonLeadInSpeech(directCandidate) || !isPlausibleCallerName(directCandidate)) {
      return {
        value: null,
        needsClarification: options.isDirectNameAnswer && directCandidate.length > 0
      };
    }
    return { value: directCandidate, needsClarification: false };
  }
  if (!hasPositiveNameEvidence(trimmed)) {
    return { value: null, needsClarification: false };
  }
  if (isLikelyCallReasonSpeech(trimmed) || !isPlausibleCallerName(trimmed)) {
    return { value: null, needsClarification: false };
  }
  return { value: null, needsClarification: false };
}
function sanitizeInvalidStoredCallerName(fields) {
  let updated = { ...fields };
  const storedName = updated.full_name?.trim();
  const pendingName = updated.name_pending_confirmation?.trim();
  if (storedName && !isPlausibleCallerName(storedName)) {
    updated = {
      ...updated,
      full_name: void 0,
      name_needs_clarification: false
    };
  }
  if (pendingName && !isPlausibleCallerName(pendingName)) {
    updated = {
      ...updated,
      name_pending_confirmation: void 0,
      name_needs_clarification: false
    };
  }
  return updated;
}
function isPlausibleServiceAddress(address) {
  const trimmed = address.trim();
  if (trimmed.length < 8 || trimmed.length > 200) {
    return false;
  }
  if (!/\d/.test(trimmed)) {
    return false;
  }
  if (containsRoofingDamageLanguage(trimmed) && !/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|place|pl)\b/i.test(
    trimmed
  )) {
    return false;
  }
  return true;
}
function isPlausibleDamageDescription(text) {
  const trimmed = text.trim();
  if (trimmed.length < 4) {
    return false;
  }
  if (isPlausibleCallerName(trimmed)) {
    return false;
  }
  return containsRoofingDamageLanguage(trimmed) || /tree|water|hole|missing|broken|hit|fell|last night|yesterday/i.test(trimmed);
}
function extractDamageOrCallReason(speech) {
  const trimmed = speech.trim();
  if (!isPlausibleDamageDescription(trimmed)) {
    return null;
  }
  return trimmed.slice(0, 500);
}
function buildNameClarificationPrompt(currentGuess, options = {}) {
  if (options.askToSpell) {
    return "Could you spell your name for me?";
  }
  if (currentGuess && currentGuess.length <= 12 && isPlausibleCallerName(currentGuess)) {
    return `I'm sorry, I heard "${currentGuess}," but I want to make sure I have your name right. Could you say or spell it one more time?`;
  }
  return "I'm sorry, I didn't catch your name. Could you say it one more time?";
}
function isCallerNameDeclinedSpeech(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /\b(prefer not to|rather not|don't want to|do not want to|won't give|will not give|no name|not giving my name)\b/.test(
    normalized
  ) || /\b(i'd rather not say|id rather not say)\b/.test(normalized);
}
function isCallerNameUnavailableSpeech(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /\b(don't know|do not know|not sure|can't remember|cant remember|unavailable)\b/.test(
    normalized
  );
}
var EARLY_CALLER_NAME_QUESTION = "Could I start with your name?";

// src/orchestrator/summary-builder.ts
function buildSummaryDataObject(fields) {
  const name = fields.full_name?.trim() ?? null;
  const phone = fields.callback_phone?.trim() ?? null;
  const address = fields.address?.trim() ?? null;
  return {
    name: name && isPlausibleCallerName(name) ? name : null,
    phone: phone && fields.callback_phone_confirmed === true ? phone : null,
    address: address && isPlausibleServiceAddress(address) ? address : null,
    reason: fields.problem_description?.trim() ?? null,
    damage: fields.problem_description?.trim() ?? null,
    urgency: fields.urgency?.trim() ?? null,
    leak: fields.emergency_or_active_leak === true || fields.emergency_or_active_leak === false ? fields.emergency_or_active_leak : null,
    insurance: fields.insurance_claim_started === true || fields.insurance_claim_started === false ? fields.insurance_claim_started : null,
    adjuster: fields.adjuster_contacted === true || fields.adjuster_contacted === false ? fields.adjuster_contacted : null,
    photos: fields.photos_available === true || fields.photos_available === false ? fields.photos_available : null,
    callbackPreference: fields.appointment_preference?.trim() ?? null,
    notes: fields.additional_notes?.trim() ?? null
  };
}
function validateSummaryData(data, fields) {
  const issues = [];
  if (fields.full_name?.trim() && !isPlausibleCallerName(fields.full_name)) {
    issues.push("invalid_name");
  }
  if (data.address && !isPlausibleServiceAddress(data.address)) {
    issues.push("invalid_address");
  }
  if (!data.reason && !data.damage) {
    issues.push("missing_reason");
  }
  return issues;
}
function buildValidatedSpokenSummary(fields) {
  const data = buildSummaryDataObject(fields);
  const issues = validateSummaryData(data, fields);
  if (issues.includes("invalid_name")) {
    return { summary: "", issues };
  }
  const detailParts = [];
  if (data.name) {
    detailParts.push(`Your name is ${data.name}`);
  }
  if (data.phone) {
    detailParts.push(`your callback number is ${formatCallbackForSpeech(data.phone)}`);
  }
  if (data.address) {
    detailParts.push(`the property is at ${data.address}`);
  }
  const situationParts = [];
  if (data.damage) {
    situationParts.push(`you're calling about ${data.damage.replace(/\.$/, "")}`);
  }
  if (data.leak === true) {
    situationParts.push("there is active water intrusion");
  } else if (data.leak === false) {
    situationParts.push("there isn't an active leak");
  }
  if (data.insurance === true) {
    situationParts.push(
      data.adjuster === true ? "you've started an insurance claim and contacted your adjuster" : data.adjuster === false ? "you've started an insurance claim but haven't contacted your adjuster yet" : "you've started an insurance claim"
    );
  } else if (data.insurance === false) {
    situationParts.push("you haven't started an insurance claim yet");
  }
  if (data.callbackPreference) {
    situationParts.push(`you'd prefer a call on ${data.callbackPreference.replace(/\.$/, "")}`);
  }
  if (data.notes) {
    situationParts.push(`I also noted ${data.notes.replace(/\.$/, "")}`);
  }
  const sentences = ["Here's what I have."];
  if (detailParts.length > 0) {
    sentences.push(`${detailParts.join(", ")}.`);
  }
  if (situationParts.length > 0) {
    const joined = situationParts.map((part) => part.replace(/\.$/, "")).join(", ");
    sentences.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`);
  }
  return {
    summary: sentences.join(" "),
    issues
  };
}

// src/orchestrator/realtime-prompts.ts
var REALTIME_OPENING_GREETING = "Thank you for calling Beau's Roofing. I'm Beau's Roofing's AI assistant. How can I help you today?";
var REALTIME_INTRO_TRANSITION = "Absolutely. I'll run you through a few questions so the roofing team has everything they need.";
var REALTIME_OPENING_QUESTION = "How can I help you today?";
var REALTIME_ANYTHING_ELSE_QUESTION = "Is there anything else you'd like the roofing team to know?";
function ensureSingleIntakeQuestion(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  const questionIndexes = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "?") {
      questionIndexes.push(index);
    }
  }
  if (questionIndexes.length <= 1) {
    return trimmed;
  }
  const firstQuestionEnd = questionIndexes[0] + 1;
  return trimmed.slice(0, firstQuestionEnd).trim();
}
function buildStructuredSpokenSummary(fields) {
  const { summary, issues } = buildValidatedSpokenSummary(fields);
  if (issues.includes("invalid_name")) {
    return "";
  }
  if (!summary) {
    return "Let me make sure I have everything right.";
  }
  return summary.replace(/^Here's what I have\./, "Let me make sure I have everything right.");
}
function buildSummaryWithConfirmation(fields) {
  return `${buildStructuredSpokenSummary(fields)} Does all of that sound correct?`;
}
function buildClosingMessage() {
  return CLOSING_MESSAGE;
}
function isAnythingElseDeclined(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(no|nope|nah|nothing|none|that's all|thats all|that is all|i'm good|im good|all set|nothing else)\b/.test(
    normalized
  ) || normalized.includes("nothing else");
}
function isSummaryConfirmed(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (normalized.split(/\s+/).length > 5) {
    return false;
  }
  if (/\b(calling|call about|roof|hail|damage|leak|insurance|appointment|address|phone|name)\b/i.test(normalized)) {
    return false;
  }
  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|sounds good|all good|perfect)\b/.test(
    normalized
  );
}
function isSummaryRejected(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}

// src/orchestrator/address-confirmation.ts
function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function hasConfirmableAddress(address) {
  if (!hasValue(address)) {
    return false;
  }
  const trimmed = address.trim();
  return /\d/.test(trimmed) && trimmed.length >= 8;
}
function formatAddressForSpeech(address) {
  let formatted = address.trim().replace(/\s+/g, " ");
  if (/\bin\b/i.test(formatted) && !/,/.test(formatted)) {
    formatted = formatted.replace(/\s+in\s+/i, ", ");
  }
  return formatted;
}
function buildAddressReadbackConfirmation(address) {
  return `I have ${formatAddressForSpeech(address)}. Is that right?`;
}
function needsAddressReadback(fields) {
  return hasConfirmableAddress(fields.address) && fields.address_confirmed !== true;
}
function isAddressConfirmed(fields) {
  return hasConfirmableAddress(fields.address) && fields.address_confirmed === true;
}
function isAddressConfirmedSpeech(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|that's correct|thats correct)\b/.test(
    normalized
  );
}
function isAddressRejectedSpeech(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}
function applyAddressCorrection(fields, speech) {
  const trimmed = speech.trim();
  if (!trimmed) {
    return fields;
  }
  return syncLegacyStringFields({
    ...fields,
    address: trimmed.slice(0, 500),
    address_confirmed: false
  });
}
function confirmAddress(fields) {
  return syncLegacyStringFields({
    ...fields,
    address: fields.address ? formatAddressForSpeech(fields.address) : fields.address,
    address_confirmed: true
  });
}

// src/orchestrator/schedule-normalizer.ts
var COMPANY_TIMEZONE = process.env.COMPANY_TIMEZONE?.trim() || "America/Chicago";
var SCHEDULE_PARSE_FALLBACK_PROMPT = "I'm sorry, I had trouble understanding the timing. What specific day and time would work best for you?";
function getLocalParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short"
  });
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return {
    year: Number.parseInt(lookup.year ?? "1970", 10),
    month: Number.parseInt(lookup.month ?? "1", 10),
    day: Number.parseInt(lookup.day ?? "1", 10),
    weekday: weekdayMap[lookup.weekday ?? "Sun"] ?? 0
  };
}
function makeUtcDate(year, month, day, hour, minute, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getLocalParts(new Date(guess), timeZone);
    const deltaHours = hour - deriveHour(new Date(guess), timeZone);
    const deltaDays = day - parts.day;
    guess += deltaDays * 864e5 + deltaHours * 36e5;
  }
  return new Date(guess);
}
function deriveHour(date, timeZone) {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false
  }).formatToParts(date);
  const lookup = Object.fromEntries(hour.map((part) => [part.type, part.value]));
  return Number.parseInt(lookup.hour ?? "0", 10);
}
function addDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay()
  };
}
function resolveWeekday(parts, targetWeekday, useNextWeek) {
  let delta = (targetWeekday - parts.weekday + 7) % 7;
  if (delta === 0 && useNextWeek) {
    delta = 7;
  }
  if (delta === 0 && !useNextWeek) {
    return parts;
  }
  return addDays(parts, delta);
}
function formatSpokenDate(parts) {
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  return `${monthNames[parts.month - 1] ?? "January"} ${parts.day}`;
}
function formatSpokenTime(hour, minute) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minutePart = `:${String(minute).padStart(2, "0")}`;
  return `${hour12}${minutePart} ${suffix}`.replace("  ", " ");
}
var SPOKEN_HOUR_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};
function parseHourToken(token) {
  const numeric = Number.parseInt(token, 10);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) {
    return numeric;
  }
  return SPOKEN_HOUR_WORDS[token.toLowerCase()] ?? null;
}
function parseTimeFromSpeech(normalized) {
  const atTime = normalized.match(/\bat\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm)?/i);
  if (atTime) {
    const parsedHour = parseHourToken(atTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }
    let hour = parsedHour;
    const minute = Number.parseInt(atTime[2] ?? "0", 10);
    const meridiem = atTime[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (!meridiem && hour <= 7) {
      hour += 12;
    }
    return { hour, minute };
  }
  const aboutTime = normalized.match(
    /\babout\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\b/i
  );
  if (aboutTime) {
    const parsedHour = parseHourToken(aboutTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }
    let hour = parsedHour;
    const minute = Number.parseInt(aboutTime[2] ?? "0", 10);
    if (hour <= 7) {
      hour += 12;
    }
    return { hour, minute };
  }
  const aroundTime = normalized.match(
    /\baround\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\b/i
  );
  if (aroundTime) {
    const parsedHour = parseHourToken(aroundTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }
    let hour = parsedHour;
    const minute = Number.parseInt(aroundTime[2] ?? "0", 10);
    if (hour <= 7) {
      hour += 12;
    }
    return { hour, minute };
  }
  const betweenTimes = normalized.match(
    /\bbetween\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(?:am|pm)?\s+and\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm)?/i
  );
  if (betweenTimes) {
    const startHour = parseHourToken(betweenTimes[1] ?? "");
    const endHour = parseHourToken(betweenTimes[3] ?? "");
    if (startHour === null || endHour === null) {
      return null;
    }
    let hour = startHour;
    const minute = Number.parseInt(betweenTimes[2] ?? "0", 10);
    const meridiem = betweenTimes[5]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (!meridiem && hour <= 7) {
      hour += 12;
    }
    return { hour, minute };
  }
  return null;
}
function weekdayIndex(name) {
  const map = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };
  return map[name.toLowerCase()] ?? null;
}
function parseScheduleSpeech(speech, now = /* @__PURE__ */ new Date(), timeZone = COMPANY_TIMEZONE) {
  try {
    return parseScheduleSpeechInternal(speech, now, timeZone);
  } catch (error) {
    logScheduleParseError(error, speech);
    return {
      status: "needs_date_clarification",
      prompt: SCHEDULE_PARSE_FALLBACK_PROMPT,
      raw: speech.trim()
    };
  }
}
function logScheduleParseError(error, speech) {
  logError("schedule_parse_failed", { speechLength: speech.trim().length }, error);
}
function parseScheduleSpeechInternal(speech, now = /* @__PURE__ */ new Date(), timeZone = COMPANY_TIMEZONE) {
  const raw = speech.trim();
  const normalized = raw.toLowerCase().replace(/[^\w\s:]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { status: "nothing_schedulable", raw };
  }
  if (/\bafter work\b|\bafter i get off\b|\bwhen i get off\b/.test(normalized)) {
    return {
      status: "needs_time_clarification",
      prompt: "What time should I put down?",
      raw
    };
  }
  const today = getLocalParts(now, timeZone);
  let targetDate = { ...today };
  let useNextWeek = false;
  if (/\btomorrow\b/.test(normalized)) {
    targetDate = addDays(today, 1);
  } else if (/\bnext week\b/.test(normalized)) {
    targetDate = addDays(today, 7);
  } else {
    const weekdayMatch = normalized.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (weekdayMatch) {
      useNextWeek = Boolean(weekdayMatch[1]);
      const weekday = weekdayIndex(weekdayMatch[2] ?? "");
      if (weekday !== null) {
        targetDate = resolveWeekday(today, weekday, useNextWeek);
      }
    }
  }
  const time = parseTimeFromSpeech(normalized);
  const hasMorning = /\bmorning\b/.test(normalized);
  const hasAfternoon = /\bafternoon\b/.test(normalized);
  const hasEvening = /\bevening\b/.test(normalized);
  if ((hasMorning || hasAfternoon || hasEvening) && !time) {
    const dateLabel = formatSpokenDate(targetDate);
    if (hasMorning) {
      return {
        status: "needs_confirmation",
        spoken: `Would ${dateLabel} between 8:00 and 11:00 AM work?`,
        isoStart: makeUtcDate(targetDate.year, targetDate.month, targetDate.day, 8, 0, timeZone).toISOString(),
        isoEnd: makeUtcDate(targetDate.year, targetDate.month, targetDate.day, 11, 0, timeZone).toISOString(),
        raw
      };
    }
    if (hasAfternoon) {
      const afternoonLabel = /\btomorrow\b/.test(normalized) ? "tomorrow afternoon" : `${formatSpokenDate(targetDate)} afternoon`;
      return {
        status: "needs_time_clarification",
        prompt: `What time ${afternoonLabel} works best?`,
        raw
      };
    }
    if (hasEvening) {
      return {
        status: "needs_time_clarification",
        prompt: "What time in the evening works best?",
        raw
      };
    }
  }
  if (!time && /\btomorrow\b|\bnext\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(normalized)) {
    return {
      status: "needs_time_clarification",
      prompt: "What time works best?",
      raw
    };
  }
  if (time) {
    const betweenTimes = normalized.match(
      /\bbetween\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(?:am|pm)?\s+and\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm)?/i
    );
    if (betweenTimes) {
      const startHour = parseHourToken(betweenTimes[1] ?? "");
      const endHour = parseHourToken(betweenTimes[3] ?? "");
      if (startHour !== null && endHour !== null) {
        let endHour24 = endHour;
        const meridiem = betweenTimes[5]?.toLowerCase();
        if (meridiem === "pm" && endHour24 < 12) {
          endHour24 += 12;
        }
        if (!meridiem && endHour24 <= 7) {
          endHour24 += 12;
        }
        let startHour24 = startHour;
        if (meridiem === "pm" && startHour24 < 12) {
          startHour24 += 12;
        }
        if (!meridiem && startHour24 <= 7) {
          startHour24 += 12;
        }
        const dateLabel2 = formatSpokenDate(targetDate);
        const startLabel = formatSpokenTime(startHour24, Number.parseInt(betweenTimes[2] ?? "0", 10));
        const endLabel = formatSpokenTime(endHour24, Number.parseInt(betweenTimes[4] ?? "0", 10));
        return {
          status: "needs_confirmation",
          spoken: `${dateLabel2} between ${startLabel.replace(/ AM| PM/, "")} and ${endLabel}`,
          isoStart: makeUtcDate(
            targetDate.year,
            targetDate.month,
            targetDate.day,
            startHour24,
            Number.parseInt(betweenTimes[2] ?? "0", 10),
            timeZone
          ).toISOString(),
          isoEnd: makeUtcDate(
            targetDate.year,
            targetDate.month,
            targetDate.day,
            endHour24,
            Number.parseInt(betweenTimes[4] ?? "0", 10),
            timeZone
          ).toISOString(),
          raw
        };
      }
    }
    const dateLabel = formatSpokenDate(targetDate);
    const spokenTime = formatSpokenTime(time.hour, time.minute);
    const isoStart = makeUtcDate(
      targetDate.year,
      targetDate.month,
      targetDate.day,
      time.hour,
      time.minute,
      timeZone
    ).toISOString();
    return {
      status: "needs_confirmation",
      spoken: `${dateLabel} at ${spokenTime}`,
      isoStart,
      raw
    };
  }
  return { status: "nothing_schedulable", raw };
}
function buildScheduleConfirmationQuestion(spoken) {
  if (spoken.startsWith("Would ")) {
    return `${spoken} Is that correct?`;
  }
  return `Just to confirm, you'd prefer a call on ${spoken.replace(/^on /i, "")}. Is that correct?`;
}
function isScheduleConfirmedSpeech(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|that works|sounds good)\b/.test(
    normalized
  );
}
function isScheduleRejectedSpeech(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}
function applyScheduleParseResult(fields, result) {
  if (result.status === "nothing_schedulable") {
    return fields;
  }
  return syncLegacyStringFields({
    ...fields,
    appointment_preference_raw: result.raw,
    schedule_confirmed: false,
    appointment_schedule_iso: result.status === "needs_confirmation" ? result.isoStart : void 0,
    appointment_schedule_iso_end: result.status === "needs_confirmation" ? result.isoEnd : void 0,
    appointment_preference: result.status === "needs_confirmation" ? result.spoken : fields.appointment_preference
  });
}
function confirmSchedule(fields) {
  const spoken = fields.appointment_preference?.trim() || fields.appointment_preference_raw?.trim() || "the requested time";
  return syncLegacyStringFields({
    ...fields,
    appointment_preference: spoken,
    schedule_confirmed: true
  });
}
function needsScheduleClarification(fields) {
  return Boolean(fields.schedule_pending_clarification);
}
function needsScheduleConfirmation(fields) {
  return Boolean(fields.appointment_schedule_iso || fields.appointment_preference) && fields.schedule_confirmed !== true && !fields.schedule_pending_clarification;
}
function isScheduleComplete(fields) {
  return typeof fields.appointment_preference === "string" && fields.appointment_preference.trim().length > 0 && fields.schedule_confirmed === true;
}
function processScheduleCapture(fields, speech, now = /* @__PURE__ */ new Date()) {
  try {
    const combined = `${fields.appointment_preference_raw ?? ""} ${speech}`.trim();
    const parsed = parseScheduleSpeech(combined, now);
    let updated = applyScheduleParseResult(
      {
        ...fields,
        appointment_preference_raw: combined
      },
      parsed
    );
    if (parsed.status === "needs_time_clarification") {
      updated = {
        ...updated,
        schedule_pending_clarification: true,
        schedule_clarification_prompt: parsed.prompt
      };
      return { fields: updated, clarificationPrompt: parsed.prompt };
    }
    if (parsed.status === "needs_date_clarification") {
      updated = {
        ...updated,
        schedule_pending_clarification: true,
        schedule_clarification_prompt: parsed.prompt
      };
      return { fields: updated, clarificationPrompt: parsed.prompt };
    }
    if (parsed.status === "needs_confirmation") {
      updated = {
        ...updated,
        schedule_pending_clarification: false,
        schedule_clarification_prompt: void 0
      };
      return {
        fields: updated,
        confirmationPrompt: buildScheduleConfirmationQuestion(parsed.spoken)
      };
    }
    updated = {
      ...updated,
      schedule_pending_clarification: true,
      schedule_clarification_prompt: SCHEDULE_PARSE_FALLBACK_PROMPT
    };
    return {
      fields: updated,
      clarificationPrompt: SCHEDULE_PARSE_FALLBACK_PROMPT
    };
  } catch (error) {
    logScheduleParseError(error, speech);
    const combined = `${fields.appointment_preference_raw ?? ""} ${speech}`.trim();
    const updated = {
      ...fields,
      appointment_preference_raw: combined,
      schedule_pending_clarification: true,
      schedule_clarification_prompt: SCHEDULE_PARSE_FALLBACK_PROMPT,
      schedule_confirmed: false
    };
    return {
      fields: updated,
      clarificationPrompt: SCHEDULE_PARSE_FALLBACK_PROMPT
    };
  }
}

// src/orchestrator/pending-question.ts
function hasValue2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function needsCallbackConfirmation(fields) {
  return Boolean(
    hasValue2(fields.callback_phone) && fields.callback_phone_confirmed !== true
  );
}
function needsAddressConfirmation(fields) {
  return hasConfirmableAddress(fields.address) && fields.address_confirmed !== true;
}
function mapRequiredFieldToPending(field) {
  switch (field) {
    case "problem_description":
      return "reason_for_call";
    case "full_name":
      return "caller_name";
    case "callback_phone":
      return "callback_phone";
    case "address":
      return "service_address";
    case "emergency_or_active_leak":
      return "active_leak";
    case "urgency":
      return "urgency";
    case "insurance_claim_started":
      return "insurance_claim";
    case "adjuster_contacted":
      return "adjuster_contacted";
    case "appointment_preference":
      return "preferred_callback_time";
    default:
      return "reason_for_call";
  }
}
function isPendingQuestionKey(value) {
  return value === "caller_name" || value === "callback_phone" || value === "callback_confirmation" || value === "service_address" || value === "address_confirmation" || value === "reason_for_call" || value === "call_reason" || value === "insurance_claim" || value === "adjuster_contacted" || value === "active_leak" || value === "urgency" || value === "preferred_callback_time" || value === "schedule_confirmation" || value === "additional_notes" || value === "summary_confirmation";
}
function isStoredPendingQuestionStillValid(fields, pending) {
  switch (pending) {
    case "callback_confirmation":
      return needsCallbackConfirmation(fields);
    case "address_confirmation":
      return needsAddressConfirmation(fields);
    case "preferred_callback_time":
      return needsScheduleClarification(fields);
    case "schedule_confirmation":
      return needsScheduleConfirmation(fields);
    default:
      return true;
  }
}
function resolvePendingQuestion(fields, conversationState) {
  const stored = fields.pending_question?.trim();
  if (stored && isPendingQuestionKey(stored) && isStoredPendingQuestionStillValid(fields, stored)) {
    return stored;
  }
  if (conversationState === "awaiting_callback_confirmation") {
    return "callback_confirmation";
  }
  if (conversationState === "awaiting_address_confirmation") {
    return "address_confirmation";
  }
  if (conversationState === "awaiting_schedule_clarification") {
    return "preferred_callback_time";
  }
  if (conversationState === "awaiting_schedule_confirmation") {
    return "schedule_confirmation";
  }
  if (conversationState === "awaiting_additional_notes") {
    return "additional_notes";
  }
  if (conversationState === "awaiting_summary_confirmation" || conversationState === "handling_correction" || conversationState === "presenting_summary") {
    return "summary_confirmation";
  }
  const nextRequired = getNextRequiredField(fields);
  if (needsCallbackConfirmation(fields) && nextRequired === "callback_phone" && isCallerNameResolved(fields) && !needsImmediateSafetyClarification(fields)) {
    return "callback_confirmation";
  }
  if (needsAddressConfirmation(fields) && nextRequired === "address" && isCallbackPhoneResolved(fields) && isCallerNameResolved(fields)) {
    return "address_confirmation";
  }
  if (needsScheduleClarification(fields) || needsScheduleConfirmation(fields)) {
    return needsScheduleConfirmation(fields) ? "schedule_confirmation" : "preferred_callback_time";
  }
  return nextRequired ? mapRequiredFieldToPending(nextRequired) : null;
}
function pendingQuestionForConversationState(conversationState) {
  switch (conversationState) {
    case "awaiting_callback_confirmation":
      return "callback_confirmation";
    case "awaiting_address_confirmation":
      return "address_confirmation";
    case "awaiting_schedule_clarification":
      return "preferred_callback_time";
    case "awaiting_schedule_confirmation":
      return "schedule_confirmation";
    case "awaiting_additional_notes":
      return "additional_notes";
    case "awaiting_summary_confirmation":
    case "handling_correction":
    case "presenting_summary":
      return "summary_confirmation";
    default:
      return null;
  }
}
function pendingQuestionForNextField(field) {
  return field ? mapRequiredFieldToPending(field) : null;
}
function attachPendingQuestion(fields, pendingQuestion) {
  if (!pendingQuestion) {
    return {
      ...fields,
      pending_question: void 0
    };
  }
  return {
    ...fields,
    pending_question: pendingQuestion
  };
}
function allowsCallbackAffirmativeReuse(pendingQuestion) {
  return pendingQuestion === "callback_phone" || pendingQuestion === "callback_confirmation";
}
function allowsBooleanDirectAnswer(pendingQuestion, field) {
  return pendingQuestion === field;
}
function resolveActivePendingQuestion(fields, conversationState, override) {
  if (override !== void 0) {
    return override;
  }
  const stored = fields.pending_question?.trim();
  if (stored && isPendingQuestionKey(stored) && isStoredPendingQuestionStillValid(fields, stored)) {
    return stored;
  }
  return resolvePendingQuestion(fields, conversationState);
}

// src/orchestrator/call-reason-handling.ts
var CALL_REASON_CLARIFICATION_PROMPT = "I'm sorry, I didn't quite catch what you're calling about. Could you tell me again?";
var CALL_REASON_NO_RESPONSE_PROMPT = "No problem\u2014what can the roofing team help you with?";
var CALLING_FOR_PATTERN = /\b(?:i'?m|i am|we'?re|we are)\s+calling(?:\s+(?:for|about|regarding))?\s+(.+)/i;
var CALLING_ABOUT_PATTERN = /\bcalling(?:\s+(?:for|about|regarding))?\s+(.+)/i;
var SHORT_YES_NO_PATTERN = /^(yes|yeah|yep|yup|no|nope|nah|not really|correct|right)\.?$/i;
var SUPPORTED_REASON_PATTERNS = [
  { pattern: /\bhail(?:\s+damage)?\b/i, value: "hail damage" },
  { pattern: /\bstorm(?:\s+damage)?\b/i, value: "storm damage" },
  { pattern: /\broof(?:\s+)?leak(?:ing)?\b/i, value: "roof leak" },
  { pattern: /\broof(?:\s+)?damage\b/i, value: "roof damage" },
  { pattern: /\bmissing\s+shingles?\b/i, value: "missing shingles" },
  { pattern: /\btree(?:\s+fell|\s+damage| damage)\b/i, value: "tree damage" },
  { pattern: /\bgutter(?:\s+problem|\s+issue|\s+damage)?\b/i, value: "gutter problem" },
  { pattern: /\broof(?:\s+)?inspection\b/i, value: "roof inspection" },
  { pattern: /\broof(?:\s+)?replacement\b/i, value: "roof replacement" },
  { pattern: /\bestimate\b/i, value: "estimate" },
  { pattern: /\binsurance(?:\s+damage|\s+claim)?\b/i, value: "insurance damage" }
];
function hasValue3(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isPendingCallReasonQuestion(pendingQuestion) {
  return pendingQuestion === "reason_for_call" || pendingQuestion === "call_reason";
}
function isListeningForCallReason(conversationState, pendingQuestion) {
  return conversationState === "listening_for_reason" || isPendingCallReasonQuestion(pendingQuestion);
}
function blocksGenericReadbackConfirmation(fields, conversationState) {
  const pending = fields.pending_question?.trim();
  if (conversationState === "listening_for_reason") {
    return true;
  }
  return isPendingCallReasonQuestion(pending);
}
function isShortYesNoReasonAnswer(speech) {
  return SHORT_YES_NO_PATTERN.test(speech.trim());
}
function stripTrailingPunctuation(text) {
  return text.replace(/[.!?]+$/g, "").trim();
}
function extractReasonPhrase(text) {
  const trimmed = stripTrailingPunctuation(text.trim());
  const callingFor = trimmed.match(CALLING_FOR_PATTERN);
  if (callingFor?.[1]) {
    return stripTrailingPunctuation(callingFor[1]);
  }
  const callingAbout = trimmed.match(CALLING_ABOUT_PATTERN);
  if (callingAbout?.[1]) {
    return stripTrailingPunctuation(callingAbout[1]);
  }
  return trimmed;
}
function normalizeCallReasonLabel(text) {
  const phrase = extractReasonPhrase(text);
  const lower = phrase.toLowerCase();
  for (const { pattern, value } of SUPPORTED_REASON_PATTERNS) {
    if (pattern.test(lower)) {
      return value;
    }
  }
  return phrase.slice(0, 500);
}
function normalizeCallReasonFromSpeech(speech) {
  const trimmed = speech.trim();
  if (!trimmed || isShortYesNoReasonAnswer(trimmed)) {
    return null;
  }
  const phrase = extractReasonPhrase(trimmed);
  const extracted = extractDamageOrCallReason(phrase) ?? extractDamageOrCallReason(trimmed);
  if (extracted) {
    return normalizeCallReasonLabel(extracted);
  }
  if (isLikelyCallReasonSpeech(trimmed) || isLikelyCallReasonSpeech(phrase)) {
    return normalizeCallReasonLabel(phrase);
  }
  return null;
}
function buildCallReasonClarificationPrompt() {
  return CALL_REASON_CLARIFICATION_PROMPT;
}
function buildCallReasonNoResponsePrompt() {
  return CALL_REASON_NO_RESPONSE_PROMPT;
}
function applyCallReasonCapture(fields, speech) {
  const trimmed = speech.trim();
  let updated = {
    ...fields,
    pending_question: "reason_for_call"
  };
  if (!trimmed) {
    return { fields: updated, resolved: false, needsClarification: true };
  }
  if (isShortYesNoReasonAnswer(trimmed)) {
    updated = {
      ...updated,
      call_reason_awaiting_clarification: true,
      call_reason_clarification_attempts: (updated.call_reason_clarification_attempts ?? 0) + 1
    };
    return { fields: updated, resolved: false, needsClarification: true };
  }
  const reason = normalizeCallReasonFromSpeech(trimmed);
  if (!reason) {
    updated = {
      ...updated,
      call_reason_awaiting_clarification: true,
      call_reason_clarification_attempts: (updated.call_reason_clarification_attempts ?? 0) + 1
    };
    return { fields: updated, resolved: false, needsClarification: true };
  }
  updated = {
    ...updated,
    problem_description: reason,
    call_reason_awaiting_clarification: false,
    name_pending_confirmation: void 0,
    name_awaiting_repeat: void 0
  };
  const volunteeredName = extractExplicitCallerName(trimmed);
  if (volunteeredName && !hasValue3(updated.full_name)) {
    updated.full_name = volunteeredName;
  }
  return { fields: updated, resolved: true, needsClarification: false };
}
function buildCallReasonResolvedReply(fields, callerPhone) {
  const withIntro = {
    ...fields,
    intake_intro_delivered: true,
    call_reason_awaiting_clarification: false,
    pending_question: void 0
  };
  const nextRequired = getNextRequiredField(withIntro);
  if (needsImmediateSafetyClarification(withIntro) && nextRequired === "emergency_or_active_leak") {
    const question2 = getNaturalTransitionQuestion(
      "emergency_or_active_leak",
      withIntro
    );
    return {
      replyText: ensureSingleIntakeQuestion(
        `${REALTIME_INTRO_TRANSITION} ${question2}`.replace(/\s+/g, " ").trim()
      ),
      fields: attachPendingQuestion(withIntro, "active_leak"),
      nextState: "collecting_intake"
    };
  }
  const targetField = nextRequired ?? "full_name";
  const pendingQuestion = mapRequiredFieldToPending(targetField);
  const question = targetField === "full_name" && !isCallerNameResolved(withIntro) ? EARLY_CALLER_NAME_QUESTION : getNaturalTransitionQuestion(targetField, withIntro, callerPhone);
  return {
    replyText: ensureSingleIntakeQuestion(
      `${REALTIME_INTRO_TRANSITION} ${question}`.replace(/\s+/g, " ").trim()
    ),
    fields: attachPendingQuestion(withIntro, pendingQuestion),
    nextState: "collecting_intake"
  };
}
function resolveCallReasonClarificationReply(fields, speech) {
  if (isShortYesNoReasonAnswer(speech) && /^(no|nope|nah|not really)\.?$/i.test(speech.trim())) {
    return buildCallReasonNoResponsePrompt();
  }
  const attempts = fields.call_reason_clarification_attempts ?? 0;
  if (attempts >= 2) {
    return buildCallReasonNoResponsePrompt();
  }
  return buildCallReasonClarificationPrompt();
}

// src/orchestrator/required-intake.ts
var BRANCH_FIELD_ORDER = [
  "urgency",
  "insurance_claim_started",
  "adjuster_contacted",
  "appointment_preference"
];
var REQUIRED_FIELD_ORDER = [
  "problem_description",
  "full_name",
  "callback_phone",
  "address",
  "emergency_or_active_leak",
  ...BRANCH_FIELD_ORDER
];
function hasValue4(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isCallerNameResolved(fields) {
  if (fields.caller_name_declined === true || fields.caller_name_unavailable === true) {
    return true;
  }
  return hasValue4(fields.full_name) && isPlausibleCallerName(fields.full_name ?? "");
}
function isAdditionalNotesResolved(fields) {
  return fields.additional_notes_responded === true;
}
function mapRequiredFieldToShared(field) {
  switch (field) {
    case "full_name":
      return "callerName";
    case "callback_phone":
      return "callbackPhone";
    case "address":
      return "serviceAddress";
    case "problem_description":
      return "callReason";
    case "urgency":
      return "urgencyStatus";
    case "emergency_or_active_leak":
      return "safetyStatus";
    case "appointment_preference":
      return "callbackSchedule";
    default:
      return "issueDetails";
  }
}
function isCallbackComplete(fields) {
  return hasValue4(fields.callback_phone) && fields.callback_phone_confirmed === true;
}
function isCallbackPhoneResolved(fields) {
  return isCallbackComplete(fields);
}
function isFieldComplete(field, fields) {
  switch (field) {
    case "full_name":
      return isCallerNameResolved(fields);
    case "callback_phone":
      return isCallbackComplete(fields);
    case "address":
      return isAddressConfirmed(fields);
    case "problem_description":
      return hasValue4(fields.problem_description);
    case "urgency":
      return hasValue4(fields.urgency);
    case "emergency_or_active_leak":
      return !isStructuredBooleanUnset(fields.emergency_or_active_leak);
    case "insurance_claim_started":
      return !isStructuredBooleanUnset(fields.insurance_claim_started);
    case "adjuster_contacted":
      if (fields.insurance_claim_started !== true) {
        return true;
      }
      return !isStructuredBooleanUnset(fields.adjuster_contacted);
    case "appointment_preference":
      return isScheduleComplete(fields);
    default:
      return false;
  }
}
function needsImmediateSafetyClarification(fields) {
  if (!isStructuredBooleanUnset(fields.emergency_or_active_leak)) {
    return false;
  }
  if (fields.emergency_acknowledged === true) {
    return true;
  }
  const problem = fields.problem_description?.toLowerCase() ?? "";
  return /\b(active leak|water (is )?((getting )?in|inside|pouring)|pouring in|flooding|emergency|collapse|structural damage|someone (is )?hurt|injured)\b/i.test(
    problem
  );
}
function collectMissingFieldsInPriorityOrder(fields) {
  const missing = [];
  if (!hasValue4(fields.problem_description)) {
    missing.push("problem_description");
  }
  if (needsImmediateSafetyClarification(fields)) {
    missing.push("emergency_or_active_leak");
  }
  if (!isCallerNameResolved(fields)) {
    missing.push("full_name");
  }
  if (!isCallbackComplete(fields)) {
    missing.push("callback_phone");
  }
  if (!isAddressConfirmed(fields)) {
    missing.push("address");
  }
  if (!isFieldComplete("emergency_or_active_leak", fields) && !missing.includes("emergency_or_active_leak")) {
    missing.push("emergency_or_active_leak");
  }
  for (const field of BRANCH_FIELD_ORDER) {
    if (!isFieldComplete(field, fields)) {
      missing.push(field);
    }
  }
  return missing;
}
function getMissingRequiredFields(fields) {
  return collectMissingFieldsInPriorityOrder(fields);
}
function getSharedMissingFields(fields) {
  const missing = /* @__PURE__ */ new Set();
  if (!isCallerNameResolved(fields)) {
    missing.add("callerName");
  }
  for (const field of getMissingRequiredFields(fields)) {
    missing.add(mapRequiredFieldToShared(field));
  }
  if (!isAdditionalNotesResolved(fields)) {
    missing.add("additionalNotes");
  }
  return [...missing];
}
function isSharedIntakeComplete(fields) {
  return getSharedMissingFields(fields).length === 0;
}
function isRequiredIntakeComplete(fields) {
  return getMissingRequiredFields(fields).length === 0 && isAdditionalNotesResolved(fields);
}
function hasValidMissingFieldLists(fields) {
  const missing = getMissingRequiredFields(fields);
  const sharedMissing = getSharedMissingFields(fields);
  return Array.isArray(missing) && Array.isArray(sharedMissing);
}
function canPresentSummary(fields) {
  if (!hasValidMissingFieldLists(fields)) {
    return false;
  }
  return isRequiredIntakeComplete(fields) && isSharedIntakeComplete(fields);
}
function canCloseCall(fields, conversationState, confirmedSpeech) {
  if (!canPresentSummary(fields)) {
    return false;
  }
  if (conversationState !== "awaiting_summary_confirmation" && conversationState !== "handling_correction") {
    return false;
  }
  return isSummaryConfirmed(confirmedSpeech);
}
function blocksPrematureCallClosing(conversationState) {
  return conversationState === "listening_for_reason" || conversationState === "collecting_intake" || conversationState === "awaiting_callback_confirmation" || conversationState === "awaiting_address_confirmation" || conversationState === "awaiting_schedule_clarification" || conversationState === "awaiting_schedule_confirmation" || conversationState === "awaiting_additional_notes";
}
function getNextRequiredField(fields) {
  return collectMissingFieldsInPriorityOrder(fields)[0] ?? null;
}
var FIELD_QUESTIONS = {
  problem_description: "What's going on with the roof?",
  full_name: EARLY_CALLER_NAME_QUESTION,
  callback_phone: "What's the best callback number?",
  address: "What's the property address?",
  emergency_or_active_leak: "Is there an active leak or water getting inside right now?",
  urgency: "How urgent is this?",
  insurance_claim_started: "Have you started an insurance claim?",
  adjuster_contacted: "Have you contacted your adjuster yet?",
  appointment_preference: "What day and time would be best for the roofing team to contact you?"
};
function getRequiredFieldQuestion(field, fields, callerPhone) {
  const firstName = fields.full_name?.trim().split(/\s+/)[0];
  if (field === "callback_phone" && callerPhone) {
    if (firstName) {
      return `${firstName}, is this the best number to reach you?`;
    }
    return "Is this the best number to reach you?";
  }
  return FIELD_QUESTIONS[field];
}
var CONTEXTUAL_TRANSITIONS = {
  full_name: EARLY_CALLER_NAME_QUESTION,
  address: "What's the property address?",
  emergency_or_active_leak: "Is there an active leak or water getting inside right now?",
  urgency: "How urgent is this?",
  insurance_claim_started: "Have you started an insurance claim?",
  adjuster_contacted: "Have you contacted your adjuster yet?",
  appointment_preference: "What day and time would be best for the roofing team to contact you?"
};
function getNaturalTransitionQuestion(field, fields, callerPhone) {
  if (field === "callback_phone") {
    return getRequiredFieldQuestion(field, fields, callerPhone);
  }
  return CONTEXTUAL_TRANSITIONS[field] ?? getRequiredFieldQuestion(field, fields, callerPhone);
}
function applyDirectAnswerToMissingField(fields, answer, callerPhone, pendingQuestion = null) {
  const trimmed = answer.trim();
  if (!trimmed) {
    return fields;
  }
  const target = getNextRequiredField(fields);
  if (!target) {
    return fields;
  }
  if (pendingQuestion !== null && pendingQuestion !== mapRequiredFieldToPending(target)) {
    return fields;
  }
  let updated = { ...fields };
  switch (target) {
    case "full_name": {
      if (isCallerNameDeclinedSpeech(trimmed)) {
        updated.caller_name_declined = true;
        updated.full_name = void 0;
        updated.name_needs_clarification = false;
        break;
      }
      if (isCallerNameUnavailableSpeech(trimmed)) {
        updated.caller_name_unavailable = true;
        updated.full_name = void 0;
        updated.name_needs_clarification = false;
        break;
      }
      if (isLikelyCallReasonSpeech(trimmed) && !extractExplicitCallerName(trimmed)) {
        break;
      }
      if (!isCallerNameResolved(updated)) {
        const validated = validateCallerNameCandidate(trimmed, { isDirectNameAnswer: true });
        if (validated.value) {
          updated.full_name = validated.value.slice(0, 100);
          updated.name_needs_clarification = false;
          updated.caller_name_declined = false;
          updated.caller_name_unavailable = false;
        } else if (validated.needsClarification) {
          updated.name_needs_clarification = true;
          updated.name_clarification_attempts = (updated.name_clarification_attempts ?? 0) + 1;
        }
      }
      break;
    }
    case "address":
      if (!hasValue4(updated.address) && isPlausibleServiceAddress(trimmed)) {
        updated.address = trimmed.slice(0, 500);
        updated.address_confirmed = false;
      }
      break;
    case "problem_description":
      if (!hasValue4(updated.problem_description)) {
        const reason = normalizeCallReasonFromSpeech(trimmed);
        if (reason) {
          updated.problem_description = reason;
        }
      }
      break;
    case "urgency":
      if (!hasValue4(updated.urgency)) {
        updated.urgency = trimmed.slice(0, 200);
      }
      break;
    case "appointment_preference":
      if (!hasValue4(updated.appointment_preference_raw)) {
        updated.appointment_preference_raw = trimmed.slice(0, 200);
        updated.schedule_confirmed = false;
      }
      break;
    case "emergency_or_active_leak":
    case "insurance_claim_started":
    case "adjuster_contacted": {
      const parsed = parseExplicitBoolean(trimmed);
      if (parsed !== null) {
        updated[target] = parsed;
      }
      break;
    }
    case "callback_phone":
      if (/^(yes|yeah|yep|correct|this one|that one|same number)\b/i.test(trimmed) && callerPhone) {
        updated.callback_phone = normalizeCallbackPhoneE164(callerPhone);
        updated.callback_phone_confirmed = false;
      }
      break;
    default:
      break;
  }
  return syncLegacyStringFields(updated);
}
function needsCallbackReadback(fields) {
  return needsCallbackConfirmation(fields);
}

// src/bridge/turn-diagnostic.ts
var activeTurn = null;
var lastTurnSnapshot = null;
var lastConversationState = null;
var lastPendingQuestion = null;
var TRACKED_FIELD_KEYS = [
  "full_name",
  "problem_description",
  "callback_phone",
  "callback_phone_confirmed",
  "address",
  "address_confirmed",
  "photos_available",
  "insurance_claim_started",
  "adjuster_contacted",
  "appointment_preference",
  "appointment_preference_raw",
  "schedule_confirmed",
  "pending_question",
  "additional_notes_responded",
  "summary_confirmed"
];
function formatTrackedValue(value) {
  if (value === void 0) {
    return null;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  return String(value);
}
function maskPhone(value) {
  if (!value?.trim()) {
    return null;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 4) {
    return `***${digits.slice(-4)}`;
  }
  return "***";
}
function formatPhotosValue(value) {
  if (value === void 0 || value === null) {
    return null;
  }
  return String(value);
}
function isTurnDiagnosticsEnabled() {
  const explicit = process.env.REALTIME_TURN_DIAGNOSTICS?.trim().toLowerCase();
  if (explicit === "true" || explicit === "1") {
    return true;
  }
  if (explicit === "false" || explicit === "0") {
    return false;
  }
  return process.env.NODE_ENV !== "production";
}
function snapshotTurnState(fields, conversationState) {
  const nextRequired = getNextRequiredField(fields);
  return {
    pendingQuestion: fields.pending_question?.trim() ?? resolvePendingQuestion(fields, conversationState),
    callbackPhonePresent: Boolean(fields.callback_phone?.trim()),
    callbackPhoneConfirmed: fields.callback_phone_confirmed === void 0 ? null : fields.callback_phone_confirmed,
    addressPresent: Boolean(fields.address?.trim()),
    addressConfirmed: fields.address_confirmed === void 0 ? null : fields.address_confirmed,
    photosAvailable: formatPhotosValue(fields.photos_available),
    insuranceClaimStarted: fields.insurance_claim_started === void 0 ? null : fields.insurance_claim_started,
    adjusterContacted: fields.adjuster_contacted === void 0 ? null : fields.adjuster_contacted,
    scheduleConfirmed: fields.schedule_confirmed === void 0 ? null : fields.schedule_confirmed,
    appointmentPreference: fields.appointment_preference?.trim() ?? null,
    nextRequiredField: nextRequired,
    needsCallbackConfirmation: needsCallbackConfirmation(fields),
    needsAddressConfirmation: needsAddressConfirmation(fields)
  };
}
function diffTrackedFields(before, after) {
  const updates = [];
  for (const field of TRACKED_FIELD_KEYS) {
    const beforeValue = formatTrackedValue(before[field]);
    const afterValue = formatTrackedValue(after[field]);
    if (beforeValue === afterValue) {
      continue;
    }
    updates.push({
      field,
      before: beforeValue,
      after: afterValue,
      accepted: true
    });
  }
  return updates;
}
function beginTurnDiagnostic(callId, turnId) {
  if (!isTurnDiagnosticsEnabled()) {
    return;
  }
  activeTurn = { callId, turnId };
}
function clearTurnDiagnostic() {
  activeTurn = null;
}
function logTurnDiagnostic(event, fields) {
  if (!isTurnDiagnosticsEnabled()) {
    return;
  }
  logInfo(event, {
    callId: activeTurn?.callId,
    turnId: activeTurn?.turnId,
    ...fields
  });
}
function logTurnStart(input) {
  beginTurnDiagnostic(input.callId, input.turnId);
  lastConversationState = input.conversationState;
  lastPendingQuestion = input.fieldsBefore.pending_question?.trim() ?? null;
  const before = snapshotTurnState(input.fieldsBefore, input.conversationState);
  lastTurnSnapshot = before;
  logTurnDiagnostic("turn_diag_start", {
    callerTranscript: input.transcript,
    conversationStateBefore: input.conversationState,
    pendingQuestionBefore: before.pendingQuestion,
    callbackPhoneBefore: maskPhone(input.fieldsBefore.callback_phone),
    callbackPhoneConfirmedBefore: before.callbackPhoneConfirmed,
    photosStateBefore: before.photosAvailable,
    insuranceStateBefore: before.insuranceClaimStarted,
    schedulingStateBefore: {
      scheduleConfirmed: before.scheduleConfirmed,
      appointmentPreference: before.appointmentPreference
    },
    stateBefore: before
  });
  return before;
}
function logAnswerHandler(input) {
  logTurnDiagnostic("turn_diag_answer_handler", {
    handlerChosen: input.handler,
    pendingQuestionUsed: input.pendingQuestion,
    shortAnswer: input.shortAnswer,
    validatedFieldUpdates: input.fieldUpdates,
    rejectedFieldUpdates: input.rejectedUpdates ?? []
  });
}
function logTurnStateAfterMerge(input) {
  const after = snapshotTurnState(input.fieldsAfter, input.conversationState);
  lastTurnSnapshot = after;
  lastPendingQuestion = input.fieldsAfter.pending_question?.trim() ?? null;
  logTurnDiagnostic("turn_diag_state_after_merge", {
    stateAfter: after,
    callbackPhoneAfter: maskPhone(input.fieldsAfter.callback_phone),
    callbackPhoneConfirmedAfter: after.callbackPhoneConfirmed,
    pendingQuestionAfter: after.pendingQuestion
  });
  return after;
}
function logNextActionSelection(input) {
  lastConversationState = input.nextConversationState;
  lastPendingQuestion = input.pendingQuestionAfter;
  logTurnDiagnostic("turn_diag_next_action", {
    nextActionSelected: input.nextAction,
    nextActionReason: input.reason,
    nextConversationState: input.nextConversationState,
    pendingQuestionAfter: input.pendingQuestionAfter,
    replyPreview: input.replyPreview.slice(0, 160)
  });
}
function explainPostIntakeBranch(fields, options) {
  const nextRequired = getNextRequiredField(fields);
  if (options.isFirstCallerTurn === true && fields.intake_intro_delivered !== true && fields.problem_description?.trim() && (nextRequired === "full_name" || nextRequired === "emergency_or_active_leak")) {
    return {
      action: "first_turn_intro",
      reason: `first caller turn with nextRequired=${nextRequired}`
    };
  }
  if (isCallerNameResolved(fields) && needsCallbackConfirmation(fields) && nextRequired === "callback_phone" && !needsImmediateSafetyClarification(fields)) {
    return {
      action: "callback_confirmation_readback",
      reason: `needsCallbackConfirmation=true callbackPhoneConfirmed=${String(fields.callback_phone_confirmed)} nextRequired=${nextRequired}`
    };
  }
  if (isCallerNameResolved(fields) && isCallbackPhoneResolved(fields) && needsAddressReadback(fields) && nextRequired === "address") {
    return {
      action: "address_confirmation_readback",
      reason: `needsAddressReadback=true addressConfirmed=${String(fields.address_confirmed)} nextRequired=${nextRequired}`
    };
  }
  if (needsScheduleClarification(fields)) {
    return {
      action: "schedule_clarification",
      reason: "needsScheduleClarification=true"
    };
  }
  if (needsScheduleConfirmation(fields)) {
    return {
      action: "schedule_confirmation",
      reason: "needsScheduleConfirmation=true"
    };
  }
  return {
    action: "standard_intake_question",
    reason: `nextRequired=${nextRequired ?? "wrap_up"}`
  };
}
function logResponseCreateSent() {
  logTurnDiagnostic("turn_diag_response_create_sent", {
    responseCreateSent: true
  });
}
function logFirstAssistantAudioReceived() {
  logTurnDiagnostic("turn_diag_first_audio_received", {
    firstAssistantAudioReceived: true
  });
}
function logCallDisconnect(input) {
  if (!isTurnDiagnosticsEnabled()) {
    logInfo("call_bridge_cleanup", { reason: input.reason, callSid: input.callId });
    return;
  }
  logWarn("turn_diag_call_disconnect", {
    callId: input.callId,
    disconnectReason: input.reason,
    lastConversationState: input.conversationState ?? lastConversationState,
    lastPendingQuestion: input.lastPendingQuestion ?? lastPendingQuestion,
    lastCallbackPhoneConfirmed: input.lastSnapshot?.callbackPhoneConfirmed ?? lastTurnSnapshot?.callbackPhoneConfirmed,
    lastState: input.lastSnapshot ?? lastTurnSnapshot,
    callerHeardMessage: input.callerHeardMessage ?? false,
    leadPreserved: input.leadPreserved ?? true
  });
  clearTurnDiagnostic();
}
function getLastTurnDiagnosticSnapshot() {
  return lastTurnSnapshot;
}

// src/bridge/playback-tracker.ts
var PlaybackTracker = class {
  bytesSent = 0;
  sampleRate = 8e3;
  recordOutboundBytes(byteCount) {
    if (byteCount > 0) {
      this.bytesSent += byteCount;
    }
  }
  getPlayedDurationMs() {
    return Math.floor(this.bytesSent / this.sampleRate * 1e3);
  }
  reset() {
    this.bytesSent = 0;
  }
};

// src/bridge/response-state-guard.ts
var ResponseStateGuard = class {
  activeResponse = false;
  clientInitiatedResponse = false;
  waitingForCaller = false;
  callerTurnReady = false;
  awaitingClosingMark = false;
  assistantAudioPending = false;
  listeningForOpeningReason = false;
  lastTriggerReason = null;
  lastTranscriptItemId = null;
  activeTurnId = 0;
  responseTurnId = null;
  canTriggerResponse(reason) {
    if (this.activeResponse) {
      this.logBlocked(reason, "active_response");
      return false;
    }
    if (this.assistantAudioPending) {
      this.logBlocked(reason, "assistant_audio_pending");
      return false;
    }
    if (this.awaitingClosingMark) {
      this.logBlocked(reason, "awaiting_closing_mark");
      return false;
    }
    if (reason !== "opening_greeting" && reason !== "opening_silence_reprompt" && this.waitingForCaller && !this.callerTurnReady) {
      this.logBlocked(reason, "waiting_for_caller");
      return false;
    }
    if (reason === "caller_turn_reply" && !this.callerTurnReady) {
      this.logBlocked(reason, "caller_turn_not_ready");
      return false;
    }
    return true;
  }
  beginOpeningReasonListen() {
    this.listeningForOpeningReason = true;
    this.waitingForCaller = true;
    this.callerTurnReady = false;
  }
  completeOpeningReasonListen() {
    this.listeningForOpeningReason = false;
    this.lastTriggerReason = null;
  }
  isListeningForOpeningReason() {
    return this.listeningForOpeningReason;
  }
  getLastTriggerReason() {
    return this.lastTriggerReason;
  }
  wasLastResponseOpeningGreeting() {
    return this.lastTriggerReason === "opening_greeting";
  }
  beginCallerTurn(turnId) {
    this.activeTurnId = turnId;
    this.callerTurnReady = false;
  }
  getActiveTurnId() {
    return this.activeTurnId;
  }
  getResponseTurnId() {
    return this.responseTurnId;
  }
  isStaleTurn(turnId) {
    if (turnId === null || turnId === void 0) {
      return false;
    }
    return turnId !== this.activeTurnId;
  }
  isStaleResponseAudio(turnId) {
    if (this.responseTurnId === null || turnId === null || turnId === void 0) {
      return false;
    }
    return turnId !== this.responseTurnId;
  }
  recordTrigger(reason, turnId) {
    logInfo("response_trigger", { reason, turnId: turnId ?? this.activeTurnId });
    this.activeResponse = true;
    this.clientInitiatedResponse = true;
    this.callerTurnReady = false;
    this.lastTriggerReason = reason;
    if (reason === "opening_greeting" || reason === "opening_silence_reprompt") {
      this.waitingForCaller = reason === "opening_silence_reprompt";
    } else {
      this.waitingForCaller = false;
    }
    this.assistantAudioPending = true;
    this.responseTurnId = turnId ?? this.activeTurnId;
  }
  onExternalResponseCreated() {
    if (this.activeResponse && this.clientInitiatedResponse) {
      this.logBlocked("caller_turn_reply", "duplicate_trigger");
      return false;
    }
    if (this.activeResponse) {
      logWarn("response_trigger_blocked", {
        reason: "vad_auto_response",
        cause: "active_response"
      });
      return true;
    }
    logInfo("response_trigger", { reason: "vad_auto_response" });
    this.activeResponse = true;
    this.clientInitiatedResponse = false;
    this.assistantAudioPending = true;
    return true;
  }
  onResponseDone() {
    this.activeResponse = false;
    this.clientInitiatedResponse = false;
    this.waitingForCaller = true;
    this.callerTurnReady = false;
    this.assistantAudioPending = false;
    this.responseTurnId = null;
    if (this.lastTriggerReason === "opening_greeting") {
      this.beginOpeningReasonListen();
    }
  }
  onResponseCancelled() {
    this.releaseActiveResponse({ waitingForCaller: true });
  }
  onResponseFailed() {
    this.releaseActiveResponse({ waitingForCaller: true });
  }
  onOpenAiError() {
    this.releaseActiveResponse({ waitingForCaller: true, preserveCallerTurnReady: true });
  }
  onWebSocketClosed() {
    this.releaseActiveResponse({ waitingForCaller: false });
  }
  releaseActiveResponse(options = {}) {
    this.activeResponse = false;
    this.clientInitiatedResponse = false;
    this.assistantAudioPending = false;
    this.responseTurnId = null;
    if (options.waitingForCaller !== void 0) {
      this.waitingForCaller = options.waitingForCaller;
    }
    if (!options.preserveCallerTurnReady) {
      this.callerTurnReady = false;
    }
  }
  prepareCallerTurnRecovery() {
    this.releaseActiveResponse({ waitingForCaller: true, preserveCallerTurnReady: true });
    this.callerTurnReady = true;
  }
  onCallerSpeechStarted() {
    this.callerTurnReady = false;
  }
  onCallerSpeechStopped() {
    this.callerTurnReady = false;
  }
  registerCallerTranscript(itemId) {
    if (itemId && itemId === this.lastTranscriptItemId) {
      logWarn("response_trigger_blocked", {
        reason: "caller_turn_reply",
        cause: "duplicate_trigger"
      });
      return false;
    }
    if (itemId) {
      this.lastTranscriptItemId = itemId;
    }
    this.callerTurnReady = true;
    return true;
  }
  onAssistantAudioDelta() {
    this.assistantAudioPending = true;
  }
  onAssistantAudioDone() {
    this.assistantAudioPending = false;
  }
  beginClosingMarkWait() {
    this.awaitingClosingMark = true;
    this.waitingForCaller = false;
    this.callerTurnReady = false;
  }
  onClosingMarkReceived() {
    this.awaitingClosingMark = false;
    this.assistantAudioPending = false;
    this.waitingForCaller = false;
    this.callerTurnReady = false;
  }
  isWaitingForCaller() {
    return this.waitingForCaller;
  }
  isActiveResponse() {
    return this.activeResponse;
  }
  isClientInitiatedResponse() {
    return this.clientInitiatedResponse;
  }
  logBlocked(reason, cause) {
    logWarn("response_trigger_blocked", { reason, cause });
  }
};

// src/bridge/opening-listening.ts
var OPENING_SILENCE_FIRST_REPROMPT_MS = 6e3;
var OPENING_SILENCE_SECOND_REPROMPT_MS = 6e3;
var OPENING_SILENCE_HANGUP_MS = 8e3;
var OPENING_STILL_THERE_PROMPT = "Are you still there?";
var OPENING_READY_REPROMPT = "I'm here whenever you're ready. How can I help you today?";
var OPENING_SILENCE_GOODBYE = "It sounds like we may have lost the connection. Thanks for calling Beau's Roofing. Have a great day.";
var OPENING_ECHO_PATTERN = /\b(thank you for calling|beau'?s roofing|ai assistant|how can i help you today|how can we help you today)\b/i;
var OPENING_FILLER_PATTERN = /^(hi|hello|hey|yes|yeah|yep|ok|okay|thanks|thank you|uh|um|hmm)\.?$/i;
function hasValue5(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isAssistantOpeningEchoTranscript(speech) {
  const normalized = speech.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === REALTIME_OPENING_QUESTION.trim().toLowerCase()) {
    return true;
  }
  if (OPENING_ECHO_PATTERN.test(normalized)) {
    return true;
  }
  const greetingNormalized = REALTIME_OPENING_GREETING.trim().toLowerCase();
  if (greetingNormalized.includes(normalized) || normalized.includes("how can i help you today")) {
    return true;
  }
  return false;
}
function isMeaningfulOpeningCallerTranscript(speech) {
  const trimmed = speech.trim();
  if (trimmed.length < 3) {
    return false;
  }
  if (isAssistantOpeningEchoTranscript(trimmed)) {
    return false;
  }
  if (OPENING_FILLER_PATTERN.test(trimmed)) {
    return false;
  }
  if (extractExplicitCallerName(trimmed)) {
    return true;
  }
  if (extractDamageOrCallReason(trimmed)) {
    return true;
  }
  if (isLikelyCallReasonSpeech(trimmed)) {
    return true;
  }
  return trimmed.split(/\s+/).length >= 4;
}
function canAdvanceAfterOpening(fields, options = {}) {
  if (options.hasReceivedMeaningfulCallerTranscript !== true) {
    return false;
  }
  return hasValue5(fields.problem_description);
}
var OpeningSilenceController = class {
  listeningForReason = false;
  meaningfulTranscriptReceived = false;
  silenceStage = 0;
  silenceTimer = null;
  isListeningForReason() {
    return this.listeningForReason && !this.meaningfulTranscriptReceived;
  }
  hasReceivedMeaningfulCallerTranscript() {
    return this.meaningfulTranscriptReceived;
  }
  getSilenceStage() {
    return this.silenceStage;
  }
  beginListeningForReason() {
    this.listeningForReason = true;
    this.meaningfulTranscriptReceived = false;
    this.silenceStage = 0;
    this.clearSilenceTimer();
  }
  onMeaningfulCallerTranscript() {
    this.meaningfulTranscriptReceived = true;
    this.listeningForReason = false;
    this.clearSilenceTimer();
  }
  reset() {
    this.listeningForReason = false;
    this.meaningfulTranscriptReceived = false;
    this.silenceStage = 0;
    this.clearSilenceTimer();
  }
  scheduleSilenceCheck(onPrompt) {
    if (!this.isListeningForReason()) {
      return;
    }
    this.clearSilenceTimer();
    const delayMs = this.silenceStage === 0 ? OPENING_SILENCE_FIRST_REPROMPT_MS : this.silenceStage === 1 ? OPENING_SILENCE_SECOND_REPROMPT_MS : OPENING_SILENCE_HANGUP_MS;
    this.silenceTimer = setTimeout(() => {
      this.handleSilenceTimeout(onPrompt);
    }, delayMs);
  }
  handleSilenceTimeout(onPrompt) {
    if (!this.isListeningForReason()) {
      return;
    }
    if (this.silenceStage === 0) {
      this.silenceStage = 1;
      onPrompt(OPENING_STILL_THERE_PROMPT);
      return;
    }
    if (this.silenceStage === 1) {
      this.silenceStage = 2;
      onPrompt(OPENING_READY_REPROMPT);
      return;
    }
    this.silenceStage = 3;
    onPrompt(OPENING_SILENCE_GOODBYE);
  }
  clearSilenceTimer() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
};

// src/orchestrator/acknowledgment-policy.ts
var CONTEXT_ACKNOWLEDGMENTS = {
  callback_phone: ["Absolutely.", "Thank you."],
  address: ["Thank you.", "All right."],
  emergency_or_active_leak: ["I'm glad everyone is safe.", "Understood."],
  insurance_claim_started: ["That helps.", "Okay."],
  adjuster_contacted: ["That helps.", "Thanks for clarifying."],
  appointment_preference: ["All right.", "Okay."],
  default: ["Thank you.", "All right.", "That helps.", "Okay."]
};
var CLOSING_PHRASES = [
  "sounds good",
  "perfect",
  "perfect, we're all set",
  "perfect we're all set",
  "you're all set",
  "you are all set",
  "that should be everything",
  "that should be it",
  "we have everything we need",
  "we've got everything",
  "we'll get that taken care of",
  "someone will reach out",
  "someone will contact you",
  "someone from the team will reach out",
  "roofing team will reach out",
  "team will reach out",
  "thanks for calling",
  "have a great day",
  "we're all set",
  "all set",
  "follow up with you",
  "send this information"
];
var AcknowledgmentPolicy = class {
  lastAcknowledgment = null;
  turnsSinceAck = 0;
  selectAcknowledgment(options) {
    this.turnsSinceAck += 1;
    if (options.isEmergency && !options.emergencyAlreadyAcknowledged) {
      const ack = "I'm glad everyone is safe.";
      this.recordUsed(ack);
      return ack;
    }
    const answer = options.answer?.trim() ?? "";
    const isSubstantiveAnswer = answer.length >= 12 && !/^(yes|no|yeah|nope|yep|yup|correct|right)\b/i.test(answer);
    const shouldAcknowledge = options.forceAck === true || options.afterConfirmation === true || isSubstantiveAnswer && (options.filledCount ?? 0) > 0 && this.turnsSinceAck >= 2;
    if (!shouldAcknowledge) {
      return null;
    }
    const pool = CONTEXT_ACKNOWLEDGMENTS[options.nextField ?? "default"] ?? CONTEXT_ACKNOWLEDGMENTS.default;
    const candidates = pool.filter((ack) => ack !== this.lastAcknowledgment);
    if (candidates.length === 0) {
      return null;
    }
    const selected = candidates[(answer.length + (options.nextField?.length ?? 0) + candidates.length) % candidates.length] ?? null;
    this.recordUsed(selected);
    return selected;
  }
  recordUsed(acknowledgment) {
    this.lastAcknowledgment = acknowledgment;
    this.turnsSinceAck = acknowledgment ? 0 : this.turnsSinceAck;
  }
  getLastAcknowledgment() {
    return this.lastAcknowledgment;
  }
  resetTurnCounter() {
    this.turnsSinceAck = 0;
    this.lastAcknowledgment = null;
  }
};
function containsClosingPhrase(text) {
  const normalized = text.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return CLOSING_PHRASES.some(
    (phrase) => normalized.includes(phrase) || normalized === phrase
  );
}
function sanitizeIntakeReply(text) {
  if (!containsClosingPhrase(text)) {
    return text;
  }
  let sanitized = text;
  for (const phrase of CLOSING_PHRASES) {
    sanitized = sanitized.replace(new RegExp(phrase, "gi"), "").trim();
  }
  return sanitized.replace(/\s+/g, " ").trim();
}
function blockClosingPhraseForConversationState(conversationState, text) {
  if (!blocksPrematureCallClosing(conversationState) || !containsClosingPhrase(text)) {
    return text;
  }
  return "";
}
function guardIntakeReply(reply, fallbackQuestion) {
  const sanitized = sanitizeIntakeReply(reply).trim();
  if (!sanitized || sanitized.length < 8) {
    return fallbackQuestion;
  }
  if (containsClosingPhrase(sanitized)) {
    return fallbackQuestion;
  }
  return sanitized;
}
function joinAcknowledgmentAndQuestion(acknowledgment, question) {
  if (!acknowledgment) {
    return question;
  }
  return `${acknowledgment} ${question.trim()}`.replace(/\s+/g, " ").trim();
}

// src/openai/realtime-session.ts
import WebSocket from "ws";
var REALTIME_DELIVERY_INSTRUCTIONS = "Professional, calm, confident, lower-pitched male receptionist. Natural American conversational delivery. Warm but not overly enthusiastic.";
var REALTIME_INSTRUCTIONS = `${REALTIME_DELIVERY_INSTRUCTIONS} You are the live phone receptionist for Beau's Roofing. Deliver exactly one short script per turn. Never ask more than one question. Never invent intake questions or confirm details that were not provided by the server.`;
function buildRealtimeSessionUpdate(voice, config2) {
  const silenceDurationMs = Math.min(
    700,
    Math.max(500, config2?.turnDetectionSilenceDurationMs ?? 600)
  );
  const prefixPaddingMs = Math.min(
    300,
    Math.max(200, config2?.turnDetectionPrefixPaddingMs ?? 250)
  );
  const threshold = Number.isFinite(config2?.turnDetectionThreshold) ? config2.turnDetectionThreshold : 0.5;
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: REALTIME_INSTRUCTIONS,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: {
            model: "whisper-1"
          },
          turn_detection: {
            type: "server_vad",
            threshold,
            prefix_padding_ms: prefixPaddingMs,
            silence_duration_ms: silenceDurationMs,
            create_response: false,
            interrupt_response: true
          }
        },
        output: {
          format: { type: "audio/pcmu" },
          voice
        }
      }
    }
  };
}
var OpenAiRealtimeSession = class {
  constructor(config2, onEvent, onDisconnect) {
    this.config = config2;
    this.onEvent = onEvent;
    this.onDisconnect = onDisconnect;
  }
  socket = null;
  connected = false;
  connectPromise = null;
  sessionReadyPromise = null;
  sessionReadyResolve = null;
  activeResponseId = null;
  activeItemId = null;
  resetSessionReady() {
    this.sessionReadyPromise = new Promise((resolve) => {
      this.sessionReadyResolve = resolve;
    });
  }
  waitForSessionReady() {
    return this.sessionReadyPromise ?? Promise.resolve();
  }
  getConfiguredVoice() {
    return this.config.openAiRealtimeVoice;
  }
  async connect() {
    if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.resetSessionReady();
    this.connectPromise = new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.config.openAiRealtimeModel)}`;
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.openAiApiKey}`
        }
      });
      this.socket = socket;
      socket.on("open", () => {
        this.connected = true;
        logInfo("openai_connected", { voice: this.config.openAiRealtimeVoice });
        this.configureSession();
        resolve();
      });
      socket.on("message", (data) => {
        this.handleMessage(data.toString());
      });
      socket.on("error", (error) => {
        logError("openai_socket_error", {}, error);
        if (!this.connected) {
          reject(error);
        }
      });
      socket.on("close", (code, reasonBuffer) => {
        this.connected = false;
        this.connectPromise = null;
        this.sessionReadyPromise = null;
        this.sessionReadyResolve = null;
        const reason = reasonBuffer.toString() || String(code);
        logWarn("openai_disconnected", { code, reason });
        this.onDisconnect(reason);
      });
    });
    return this.connectPromise;
  }
  configureSession() {
    this.send(buildRealtimeSessionUpdate(this.config.openAiRealtimeVoice, this.config));
  }
  handleMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      logWarn("openai_malformed_event");
      return;
    }
    if (event.type === "session.updated") {
      this.sessionReadyResolve?.();
      this.sessionReadyResolve = null;
    }
    if (event.type === "response.created") {
      const response = event.response;
      this.activeResponseId = response?.id ?? null;
    }
    if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item?.id) {
        this.activeItemId = item.id;
      }
    }
    if (event.type === "response.done" || event.type === "response.cancelled" || event.type === "response.canceled" || event.type === "response.failed") {
      this.activeResponseId = null;
    }
    if (event.type === "error") {
      logError("openai_realtime_error", {
        errorType: String(event.error ?? "unknown")
      });
    }
    this.onEvent(event);
  }
  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      logWarn("openai_send_skipped_socket_closed", { type: String(payload.type) });
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }
  appendCallerAudio(base64Audio) {
    if (!base64Audio) {
      return;
    }
    this.send({
      type: "input_audio_buffer.append",
      audio: base64Audio
    });
  }
  speakScript(exactText, reason, canSend, onSent) {
    const trimmed = exactText.trim();
    if (!trimmed) {
      return "blocked";
    }
    if (!canSend(reason)) {
      return "blocked";
    }
    onSent(reason);
    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: `${REALTIME_DELIVERY_INSTRUCTIONS} Deliver ONLY the script below as one natural live phone response for Beau's Roofing. Ask at most one question. Do not add any extra sentences. Do not say the caller is all set. Do not say someone will reach out. Do not say thanks for calling. Intake is not complete \u2014 keep the conversation going. Keep the same facts as the script:

` + trimmed
      }
    });
    return "sent";
  }
  cancelActiveResponse() {
    if (this.activeResponseId) {
      this.send({
        type: "response.cancel",
        response_id: this.activeResponseId
      });
      return;
    }
    this.send({ type: "response.cancel" });
  }
  getActiveResponseId() {
    return this.activeResponseId;
  }
  getActiveItemId() {
    return this.activeItemId;
  }
  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1e3, "call ended");
    }
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.sessionReadyPromise = null;
    this.sessionReadyResolve = null;
    this.activeResponseId = null;
    this.activeItemId = null;
  }
};

// ../../lib/call-summary.ts
var FILLER_WORDS = /\b(uh+|um+|uh huh|you know|i mean|kind of|sort of|like|basically|literally|anyway)\b/gi;
var OPENING_FILLER = /^(hey|hi|hello|yeah|yep|so|well|okay|ok|thanks|thank you)[,.]?\s+/i;
var CALL_PREFIX = /^(i'?m calling because|calling because|i wanted to (call|see|ask)|i need to (report|tell you about|let you know))\s+/i;
var UNCERTAIN_PHRASES = /\b(i think|hopefully|maybe|probably|it sounds like|sounds like|i guess|i believe|i feel like)\b/gi;
function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isYes(value) {
  return hasText(value) && /^(yes|yeah|yep|yup|true|correct|sure)$/i.test(value.trim());
}
function isNo(value) {
  return hasText(value) && /^(no|nope|nah|false|none|not|negative)$/i.test(value.trim());
}
function capitalize(text) {
  if (!text) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function stripConversationalFiller(text) {
  let cleaned = text.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    cleaned = cleaned.replace(OPENING_FILLER, "").replace(CALL_PREFIX, "").replace(UNCERTAIN_PHRASES, "").replace(FILLER_WORDS, " ").replace(/\s{2,}/g, " ").trim();
  }
  return cleaned.replace(/[,.]$/, "").trim();
}
function extractDamageTiming(text) {
  const lower = text.toLowerCase();
  if (/\byesterday\b/.test(lower)) {
    return "yesterday";
  }
  if (/\blast night\b/.test(lower)) {
    return "last night";
  }
  if (/\bthis morning\b/.test(lower)) {
    return "this morning";
  }
  if (/\btoday\b/.test(lower)) {
    return "today";
  }
  if (/\blast week\b/.test(lower)) {
    return "last week";
  }
  if (/\brecent(ly)?\b/.test(lower)) {
    return "recently";
  }
  return null;
}
function extractLeakLocation(text) {
  const match = text.match(
    /\b(?:into|in|affecting)\s+(?:the\s+)?([a-z]+(?:\s+[a-z]+)?)\b/i
  );
  if (match?.[1] && !/home|house|property|inside/.test(match[1])) {
    return match[1].trim();
  }
  const roomMatch = text.match(
    /\b(kitchen|bathroom|bedroom|living room|garage|basement|attic|dining room)\b/i
  );
  return roomMatch?.[1]?.trim() ?? null;
}
function professionalizeFreeText(text) {
  const cleaned = stripConversationalFiller(text);
  if (!cleaned) {
    return "";
  }
  return cleaned.replace(/\bmessed up\b/gi, "damaged").replace(/\bgot hit really bad\b/gi, "sustained significant damage").replace(/\bhit really bad\b/gi, "sustained significant damage").replace(/\bstarted leaking\b/gi, "water intrusion began").replace(/\bleaking\b/gi, "water intrusion").replace(/\bfiled an insurance claim\b/gi, "insurance claim started").replace(/\btalked to insurance\b/gi, "insurance claim initiated").replace(/\bspoken to insurance\b/gi, "insurance claim initiated").replace(/\bshingles everywhere\b/gi, "loose shingles reported").replace(/\bshingles all over\b/gi, "loose shingles reported").replace(/\bneed someone to come\b/gi, "inspection requested").replace(/\bjust need\b/gi, "requested").trim();
}
function summarizeDamageReason(fields) {
  const problem = hasText(fields.problem_description) ? stripConversationalFiller(fields.problem_description) : "";
  const projectType = fields.project_type?.trim().toLowerCase() ?? "";
  const lower = problem.toLowerCase();
  const timing = extractDamageTiming(problem);
  if (/shingles everywhere|shingles all over|missing shingles|loose shingles/i.test(lower)) {
    return /storm|hail|wind|tornado|hurricane/i.test(lower) || fields.storm_damage === "yes" ? "Loose shingles reported following the storm" : "Loose shingles reported on the roof system";
  }
  if (/hail/.test(lower) || projectType === "storm damage") {
    return timing ? `Suspected hail damage that occurred ${timing}` : "Suspected hail damage";
  }
  if (/wind/.test(lower) || projectType === "wind damage") {
    return timing ? `Suspected wind damage that occurred ${timing}` : "Suspected wind damage";
  }
  if (/tree|through the roof|collapse|caved/.test(lower)) {
    return "Structural roof damage requiring urgent attention";
  }
  if (/tornado|hurricane|storm/.test(lower) || fields.storm_damage === "yes") {
    return timing ? `Storm-related roof damage reported ${timing}` : "Storm-related roof damage";
  }
  if (projectType === "replacement") {
    return "Roof replacement inquiry";
  }
  if (projectType === "repair") {
    return "Roof repair request";
  }
  if (projectType === "inspection") {
    return "Roof inspection request";
  }
  if (problem) {
    const professional = professionalizeFreeText(problem);
    if (professional) {
      return capitalize(professional);
    }
  }
  if (projectType) {
    return capitalize(`${projectType} inquiry`);
  }
  return null;
}
function summarizeLeak(fields) {
  const problem = fields.problem_description ?? "";
  const notes = fields.additional_notes ?? "";
  const combined = `${problem} ${notes}`.toLowerCase();
  if (!isYes(fields.active_leak) && !/leak|water|pouring|drip/.test(combined)) {
    if (isNo(fields.active_leak)) {
      return "No active interior water intrusion reported";
    }
    return null;
  }
  const location = extractLeakLocation(`${problem} ${notes}`);
  if (location) {
    return `Interior water intrusion affecting the ${location}`;
  }
  return "Active interior water intrusion reported";
}
function summarizeInsurance(fields) {
  if (isYes(fields.insurance_claim)) {
    return "Insurance claim has already been initiated";
  }
  if (isNo(fields.insurance_claim)) {
    return "Insurance claim has not been initiated";
  }
  return null;
}
function summarizeAppointment(fields) {
  const raw = fields.appointment_preference;
  if (!hasText(raw) || raw.toLowerCase() === "none") {
    return null;
  }
  let cleaned = stripConversationalFiller(raw).replace(/^i just need someone to come\b/i, "").replace(/^i need someone (out|to come)\b/i, "").replace(/^someone to come\b/i, "").replace(/^please come\b/i, "").trim();
  if (!cleaned) {
    cleaned = raw.trim();
  }
  if (/^(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(cleaned)) {
    return `Requested inspection ${cleaned.toLowerCase()}`;
  }
  return `Requested inspection: ${cleaned}`;
}
function summarizeUrgency(fields) {
  const urgency = fields.urgency?.trim().toLowerCase();
  if (!urgency) {
    return null;
  }
  if (urgency === "emergency") {
    return "Marked as urgent priority";
  }
  if (urgency === "flexible") {
    return "Flexible scheduling noted";
  }
  return "Standard scheduling requested";
}
function summarizeAdditionalNotes(fields) {
  const notes = fields.additional_notes;
  if (!hasText(notes) || notes.toLowerCase() === "none") {
    return null;
  }
  const professional = professionalizeFreeText(notes);
  return professional ? capitalize(professional) : null;
}
function buildProfessionalSummaryContent(fields) {
  return {
    reason: summarizeDamageReason(fields),
    contactName: hasText(fields.full_name) ? fields.full_name.trim() : null,
    location: hasText(fields.address) ? fields.address.trim() : null,
    leak: summarizeLeak(fields),
    insurance: summarizeInsurance(fields),
    urgency: summarizeUrgency(fields),
    appointment: summarizeAppointment(fields),
    additionalNotes: summarizeAdditionalNotes(fields)
  };
}
function buildCrmCallSummary(fields) {
  const content = buildProfessionalSummaryContent(fields);
  const lines = [];
  if (content.reason) {
    lines.push(`Reason: ${content.reason}`);
  }
  if (content.contactName) {
    lines.push(`Contact: ${content.contactName}`);
  }
  if (hasText(fields.callback_phone)) {
    lines.push(`Phone: ${fields.callback_phone.trim()}`);
  }
  if (content.location) {
    lines.push(`Property: ${content.location}`);
  }
  if (content.leak) {
    lines.push(`Water intrusion: ${content.leak}`);
  }
  if (content.insurance) {
    lines.push(`Insurance: ${content.insurance}`);
  }
  if (content.urgency) {
    lines.push(`Priority: ${content.urgency}`);
  }
  if (content.appointment) {
    lines.push(`Scheduling: ${content.appointment}`);
  }
  if (content.additionalNotes) {
    lines.push(`Notes: ${content.additionalNotes}`);
  }
  return lines.join("\n");
}

// ../../lib/activity.ts
async function createActivity(supabase, {
  companyId,
  leadId = null,
  activityType,
  summary,
  actorUserId = null,
  metadata = {}
}) {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new Error("Activity summary cannot be empty.");
  }
  const { data, error } = await supabase.from("activity_history").insert({
    company_id: companyId,
    lead_id: leadId,
    activity_type: activityType,
    summary: trimmedSummary,
    metadata,
    actor_user_id: actorUserId
  }).select("*").single();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error("Failed to create activity record.");
  }
  return {
    ...data,
    metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {}
  };
}

// ../../lib/business-settings.ts
var WEEKDAYS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" }
];
function normalizeTimeValue(value) {
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    return value.slice(0, 5);
  }
  return value;
}
function parseBusinessHours(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const hours = {};
  for (const day of WEEKDAYS) {
    const entry = value[day.key];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const open = "open" in entry && typeof entry.open === "string" ? normalizeTimeValue(entry.open) : "";
    const close = "close" in entry && typeof entry.close === "string" ? normalizeTimeValue(entry.close) : "";
    if (open && close) {
      hours[day.key] = { open, close };
    }
  }
  return hours;
}
async function getBusinessSettingsByCompanyId(supabase, companyId) {
  const { data, error } = await supabase.from("business_settings").select("*").eq("company_id", companyId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }
  return {
    ...data,
    business_hours: parseBusinessHours(data.business_hours)
  };
}

// ../../lib/supabase/service.ts
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    return null;
  }
  return createSupabaseClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

// ../../lib/employee-lead-notification-content.ts
var EMPLOYEE_PHONE_AI_LEAD_KIND = "employee_phone_ai_lead";
function hasText2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function displayValue(value, fallback = "Not provided") {
  return hasText2(value) ? value.trim() : fallback;
}
function isAffirmative(value) {
  return hasText2(value) && /^(yes|yeah|yep|yup|true|correct|started|filed|active)/i.test(value.trim());
}
function resolveEmployeeNotificationStyle(priorityLabel) {
  return priorityLabel === "Emergency" || priorityLabel === "High" ? "urgent" : "normal";
}
function buildEmployeePriorityReason(fields, priorityLabel) {
  if (priorityLabel === "Emergency") {
    if (fields.emergency_acknowledged) {
      return "Emergency urgency was detected during the call.";
    }
    return "Caller reported an emergency roofing situation.";
  }
  if (priorityLabel === "High") {
    if (isAffirmative(fields.active_leak)) {
      return "Active water intrusion was reported.";
    }
    if (fields.urgency?.toLowerCase().includes("urgent")) {
      return "Caller requested urgent attention.";
    }
    return "Lead was marked high priority based on urgency signals.";
  }
  return null;
}
function buildEmployeeLeadNotificationContent(input) {
  const priorityLabel = derivePhoneLeadPriorityLabel(input.fields);
  const style = resolveEmployeeNotificationStyle(priorityLabel);
  const priorityReason = buildEmployeePriorityReason(
    input.fields,
    priorityLabel
  );
  const summary = input.fields.crm_summary ?? buildCrmCallSummary(input.fields);
  const issue = displayValue(input.fields.problem_description) !== "Not provided" ? displayValue(input.fields.problem_description) : displayValue(input.fields.project_type);
  const lines = [
    `Customer: ${displayValue(input.lead.full_name)}`,
    `Phone: ${displayValue(input.lead.phone)}`,
    `Address: ${displayValue(input.lead.address_line_1)}`,
    `Priority: ${priorityLabel}`,
    ...priorityReason ? [`Why urgent: ${priorityReason}`] : [],
    `Issue: ${issue}`,
    `Active leak: ${displayValue(input.fields.active_leak)}`,
    `Insurance: ${input.lead.insurance_claim ? "Yes" : displayValue(input.fields.insurance_claim, "No")}`,
    `Appointment: ${displayValue(input.fields.appointment_preference)}`,
    `Source: Phone AI`,
    "",
    "Summary:",
    summary
  ];
  if (input.dashboardUrl) {
    lines.push("", `View lead: ${input.dashboardUrl}`);
  }
  const body = lines.join("\n");
  const smsSubjectLine = style === "urgent" ? "URGENT PHONE AI LEAD" : "New Phone AI Lead";
  const emailSubject = style === "urgent" ? `URGENT PHONE AI LEAD \u2014 ${displayValue(input.lead.full_name)}${priorityReason ? ` \u2014 ${priorityReason}` : ""}` : `New Phone AI Lead \u2014 ${displayValue(input.lead.full_name)}`;
  const smsBody = style === "urgent" ? `${smsSubjectLine}

${body}`.slice(0, 1500) : `${smsSubjectLine}

${body}`.slice(0, 1500);
  return {
    style,
    priorityLabel,
    priorityReason,
    smsSubjectLine,
    emailSubject,
    smsBody,
    emailBody: `${emailSubject}

${body}`
  };
}
function getLeadDashboardUrl(leadId) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  if (!configured) {
    return null;
  }
  const origin = configured.startsWith("http") ? configured.replace(/\/$/, "") : `https://${configured.replace(/\/$/, "")}`;
  return `${origin}/dashboard/leads/${leadId}`;
}
async function resolveEmployeeNotificationRecipients(company) {
  const supabase = createServiceClient();
  const settings = supabase ? await getBusinessSettingsByCompanyId(supabase, company.id) : null;
  const smsEnabled = settings?.sms_follow_up_enabled ?? false;
  const emailEnabled = settings?.email_follow_up_enabled ?? false;
  const smsRecipient = hasText2(company.business_phone) ? company.business_phone.trim() : null;
  const emailRecipient = settings?.notification_email?.trim() || company.business_email?.trim() || null;
  return {
    smsRecipient,
    emailRecipient,
    emergencySmsRecipient: smsRecipient,
    emergencyEmailRecipient: emailRecipient,
    smsEnabled,
    emailEnabled
  };
}
function pickSmsRecipient(recipients, style) {
  if (!recipients.smsEnabled) {
    return null;
  }
  if (style === "urgent") {
    return recipients.emergencySmsRecipient ?? recipients.smsRecipient;
  }
  return recipients.smsRecipient;
}
function pickEmailRecipient(recipients, style) {
  if (!recipients.emailEnabled) {
    return null;
  }
  if (style === "urgent") {
    return recipients.emergencyEmailRecipient ?? recipients.emailRecipient;
  }
  return recipients.emailRecipient;
}

// ../../lib/notifications.ts
async function createEmployeeNotificationRecord(supabase, input) {
  const { data, error } = await supabase.from("notifications").insert({
    company_id: input.companyId,
    lead_id: input.leadId,
    channel: input.channel,
    recipient: input.recipient.trim(),
    subject: input.channel === "email" ? input.subject?.trim() || null : null,
    message: input.message.trim(),
    status: input.status ?? "queued",
    sent_at: input.sentAt ?? null,
    error_message: input.errorMessage ?? null,
    notification_kind: input.notificationKind ?? null
  }).select("*").single();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error("Failed to create notification record.");
  }
  return data;
}
async function getEmployeeNotificationForLead(supabase, leadId, channel, notificationKind) {
  const { data, error } = await supabase.from("notifications").select("*").eq("lead_id", leadId).eq("channel", channel).eq("notification_kind", notificationKind).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// ../../lib/twilio/sms-outbound.ts
import twilio from "twilio";
function getTwilioSmsConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = process.env.TWILIO_PHONE_NUMBER?.trim();
  if (!accountSid || !authToken || !fromNumber) {
    return null;
  }
  return { accountSid, authToken, fromNumber };
}
async function sendTwilioSms(to, body) {
  const trimmedTo = to.trim();
  const trimmedBody = body.trim();
  if (!trimmedTo || !trimmedBody) {
    return {
      delivered: false,
      simulated: true,
      reason: "missing_recipient_or_body"
    };
  }
  const config2 = getTwilioSmsConfig();
  if (!config2) {
    return {
      delivered: false,
      simulated: true,
      reason: "twilio_not_configured"
    };
  }
  try {
    const client = twilio(config2.accountSid, config2.authToken);
    const message = await client.messages.create({
      to: trimmedTo,
      from: config2.fromNumber,
      body: trimmedBody
    });
    return {
      delivered: true,
      sid: message.sid,
      simulated: false
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Twilio SMS failed: ${reason}`);
  }
}

// ../../lib/employee-lead-notifications.ts
var MAX_EMPLOYEE_NOTIFICATION_ATTEMPTS = 3;
var RETRY_DELAYS_MS = [0, 750, 2e3];
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function redactCallSid(callSid) {
  if (callSid.length <= 8) {
    return callSid;
  }
  return `${callSid.slice(0, 4)}...${callSid.slice(-4)}`;
}
function redactPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) {
    return "***";
  }
  return `***${digits.slice(-4)}`;
}
async function recordEmployeeNotificationState(callSid, input) {
  const supabase = createServiceClient();
  if (!supabase) {
    return;
  }
  await supabase.from("call_sessions").update({
    employee_notification_status: input.status,
    employee_notification_attempts: input.attempts,
    employee_notification_last_error: input.error ?? null,
    ...input.status === "sent" || input.status === "partial" ? { employee_notification_sent_at: (/* @__PURE__ */ new Date()).toISOString() } : {}
  }).eq("twilio_call_sid", callSid);
}
async function logEmployeeActivity(companyId, leadId, summary, metadata) {
  const supabase = createServiceClient();
  if (!supabase) {
    return;
  }
  try {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "notification_queued",
      summary,
      metadata
    });
  } catch (error) {
    console.error("Failed to record employee notification activity:", error);
  }
}
async function shouldSkipEmployeeNotification(session) {
  return session.employee_notification_status === "sent";
}
async function loadCompany(companyId) {
  const supabase = createServiceClient();
  if (!supabase) {
    return null;
  }
  const { data, error } = await supabase.from("companies").select("*").eq("id", companyId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}
async function loadLead(leadId, companyId) {
  const supabase = createServiceClient();
  if (!supabase) {
    return null;
  }
  const { data, error } = await supabase.from("leads").select("*").eq("id", leadId).eq("company_id", companyId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}
async function deliverEmployeeChannelNotification(input) {
  const supabase = createServiceClient();
  if (!supabase) {
    return {
      channel: input.channel,
      ok: false,
      error: "Supabase service client is not configured."
    };
  }
  const existing = await getEmployeeNotificationForLead(
    supabase,
    input.leadId,
    input.channel,
    EMPLOYEE_PHONE_AI_LEAD_KIND
  );
  if (existing) {
    if (existing.status === "sent" || existing.status === "simulated") {
      return { channel: input.channel, ok: true };
    }
    if (input.channel === "sms") {
      try {
        const smsResult = await sendTwilioSms(input.recipient, input.message);
        const status = smsResult.delivered ? "sent" : "simulated";
        await supabase.from("notifications").update({
          message: input.message,
          status,
          sent_at: smsResult.delivered ? (/* @__PURE__ */ new Date()).toISOString() : null,
          error_message: smsResult.delivered ? null : smsResult.reason
        }).eq("id", existing.id);
        await logEmployeeActivity(
          input.companyId,
          input.leadId,
          input.isRetry ? "Employee notification retry succeeded" : "Employee SMS sent",
          {
            channel: "sms",
            recipient: redactPhone(input.recipient),
            delivery: status,
            notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND
          }
        );
        return { channel: "sms", ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await supabase.from("notifications").update({
          status: "failed",
          error_message: message
        }).eq("id", existing.id);
        return { channel: "sms", ok: false, error: message };
      }
    }
    await supabase.from("notifications").update({
      subject: input.subject,
      message: input.message,
      status: "queued",
      error_message: null
    }).eq("id", existing.id);
    await logEmployeeActivity(
      input.companyId,
      input.leadId,
      input.isRetry ? "Employee notification retry succeeded" : "Employee email sent",
      {
        channel: "email",
        recipient: input.recipient.replace(/(.{2}).+(@.+)/, "$1***$2"),
        delivery: "queued",
        notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND
      }
    );
    return { channel: "email", ok: true };
  }
  if (input.channel === "sms") {
    try {
      const smsResult = await sendTwilioSms(input.recipient, input.message);
      const status = smsResult.delivered ? "sent" : "simulated";
      await createEmployeeNotificationRecord(supabase, {
        companyId: input.companyId,
        leadId: input.leadId,
        channel: "sms",
        recipient: input.recipient,
        message: input.message,
        notificationKind: EMPLOYEE_PHONE_AI_LEAD_KIND,
        status,
        sentAt: smsResult.delivered ? (/* @__PURE__ */ new Date()).toISOString() : null,
        errorMessage: smsResult.delivered ? null : smsResult.reason
      });
      await logEmployeeActivity(
        input.companyId,
        input.leadId,
        input.isRetry ? "Employee notification retry succeeded" : "Employee SMS sent",
        {
          channel: "sms",
          recipient: redactPhone(input.recipient),
          delivery: status,
          notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND
        }
      );
      return { channel: "sms", ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await createEmployeeNotificationRecord(supabase, {
          companyId: input.companyId,
          leadId: input.leadId,
          channel: "sms",
          recipient: input.recipient,
          message: input.message,
          notificationKind: EMPLOYEE_PHONE_AI_LEAD_KIND,
          status: "failed",
          errorMessage: message
        });
      } catch {
      }
      return { channel: "sms", ok: false, error: message };
    }
  }
  try {
    await createEmployeeNotificationRecord(supabase, {
      companyId: input.companyId,
      leadId: input.leadId,
      channel: "email",
      recipient: input.recipient,
      subject: input.subject,
      message: input.message,
      notificationKind: EMPLOYEE_PHONE_AI_LEAD_KIND,
      status: "queued"
    });
    await logEmployeeActivity(
      input.companyId,
      input.leadId,
      input.isRetry ? "Employee notification retry succeeded" : "Employee email sent",
      {
        channel: "email",
        recipient: input.recipient.replace(/(.{2}).+(@.+)/, "$1***$2"),
        delivery: "queued",
        notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND
      }
    );
    return { channel: "email", ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { channel: "email", ok: false, error: message };
  }
}
async function notifyEmployeesOfPhoneAiLead(input) {
  const session = input.session;
  const leadId = input.leadId;
  if (!leadId || !session.company_id) {
    return { status: "skipped", reason: "Missing lead or company context." };
  }
  if (await shouldSkipEmployeeNotification(session)) {
    return { status: "already_sent", channels: [] };
  }
  const company = await loadCompany(session.company_id);
  if (!company) {
    return { status: "skipped", reason: "Company not found." };
  }
  const lead = await loadLead(leadId, session.company_id);
  if (!lead) {
    return { status: "skipped", reason: "Lead not found." };
  }
  const fields = input.fields ?? session.collected_fields ?? {};
  const recipients = await resolveEmployeeNotificationRecipients(company);
  const content = buildEmployeeLeadNotificationContent({
    lead,
    fields,
    callSid: session.twilio_call_sid,
    conversationId: session.id,
    dashboardUrl: getLeadDashboardUrl(leadId)
  });
  const smsRecipient = pickSmsRecipient(recipients, content.style);
  const emailRecipient = pickEmailRecipient(recipients, content.style);
  if (!smsRecipient && !emailRecipient) {
    await recordEmployeeNotificationState(session.twilio_call_sid, {
      status: "skipped",
      attempts: session.employee_notification_attempts ?? 0,
      error: "No enabled employee notification recipients configured."
    });
    return {
      status: "skipped",
      reason: "No enabled employee notification recipients configured."
    };
  }
  const startingAttempts = session.employee_notification_attempts ?? 0;
  const isRetry = startingAttempts > 0;
  let lastError = "Employee notification failed.";
  for (let attempt = 1; attempt <= MAX_EMPLOYEE_NOTIFICATION_ATTEMPTS; attempt += 1) {
    const totalAttempts = startingAttempts + attempt;
    const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 2e3;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    await recordEmployeeNotificationState(session.twilio_call_sid, {
      status: "pending",
      attempts: totalAttempts,
      error: null
    });
    if (attempt === 1 && !isRetry) {
      await logEmployeeActivity(session.company_id, leadId, "Employee notification queued", {
        callSid: redactCallSid(session.twilio_call_sid),
        conversationId: session.id,
        priority: content.priorityLabel,
        style: content.style,
        notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND
      });
    }
    const deliveries = [];
    const errors = [];
    if (smsRecipient) {
      deliveries.push(
        deliverEmployeeChannelNotification({
          companyId: session.company_id,
          leadId,
          channel: "sms",
          recipient: smsRecipient,
          subject: null,
          message: content.smsBody,
          isRetry
        })
      );
    }
    if (emailRecipient) {
      deliveries.push(
        deliverEmployeeChannelNotification({
          companyId: session.company_id,
          leadId,
          channel: "email",
          recipient: emailRecipient,
          subject: content.emailSubject,
          message: content.emailBody,
          isRetry
        })
      );
    }
    const results = await Promise.all(deliveries);
    const successfulChannels = results.filter((result) => result.ok).map((r) => r.channel);
    const failed = results.filter((result) => !result.ok);
    if (failed.length === 0) {
      await recordEmployeeNotificationState(session.twilio_call_sid, {
        status: "sent",
        attempts: totalAttempts,
        error: null
      });
      console.info(
        JSON.stringify({
          event: "employee_notification_sent",
          callSid: redactCallSid(session.twilio_call_sid),
          leadId,
          channels: successfulChannels,
          style: content.style
        })
      );
      return { status: "sent", channels: successfulChannels };
    }
    if (successfulChannels.length > 0) {
      lastError = failed.map((item) => item.error).filter(Boolean).join("; ");
      await recordEmployeeNotificationState(session.twilio_call_sid, {
        status: "partial",
        attempts: totalAttempts,
        error: lastError
      });
      await logEmployeeActivity(
        session.company_id,
        leadId,
        "Employee notification failed",
        {
          callSid: redactCallSid(session.twilio_call_sid),
          failed_channels: failed.map((item) => item.channel),
          notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND
        }
      );
      return {
        status: "partial",
        channels: successfulChannels,
        error: lastError
      };
    }
    lastError = failed.map((item) => item.error).filter(Boolean).join("; ") || "Employee notification failed.";
    console.error(
      JSON.stringify({
        event: "employee_notification_failed",
        callSid: redactCallSid(session.twilio_call_sid),
        leadId,
        attempt: totalAttempts,
        errorMessage: lastError
      })
    );
  }
  await recordEmployeeNotificationState(session.twilio_call_sid, {
    status: "failed",
    attempts: startingAttempts + MAX_EMPLOYEE_NOTIFICATION_ATTEMPTS,
    error: lastError
  });
  await logEmployeeActivity(session.company_id, leadId, "Employee notification failed", {
    callSid: redactCallSid(session.twilio_call_sid),
    errorMessage: lastError,
    notification_kind: EMPLOYEE_PHONE_AI_LEAD_KIND
  });
  return {
    status: "failed",
    error: lastError,
    attempts: startingAttempts + MAX_EMPLOYEE_NOTIFICATION_ATTEMPTS
  };
}
async function notifyEmployeesOfPhoneAiLeadIfNeeded(input) {
  if (input.session.employee_notification_status === "sent" || input.session.employee_notification_status === "skipped") {
    return { status: "already_sent", channels: [] };
  }
  return notifyEmployeesOfPhoneAiLead(input);
}

// ../../lib/intake.ts
function normalizePhoneDigits(phone) {
  return phone.replace(/\D/g, "");
}
function isValidIntakePhone(phone) {
  const digits = normalizePhoneDigits(phone);
  return digits.length >= 10 && digits.length <= 15;
}

// ../../lib/customer-confirmation-content.ts
function hasText3(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function formatPhoneForTwilioSms(phone) {
  const digits = normalizePhoneDigits(phone);
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}
function resolveCustomerPhone(lead, fields, callerPhone) {
  const candidates = [
    lead.phone,
    fields.callback_phone,
    callerPhone
  ].filter(hasText3);
  for (const candidate of candidates) {
    if (!isValidIntakePhone(candidate)) {
      continue;
    }
    const formatted = formatPhoneForTwilioSms(candidate);
    if (formatted) {
      return formatted;
    }
  }
  return null;
}
function formatCustomerDisplayName(fullName) {
  const trimmed = fullName?.trim();
  if (!trimmed || /^unknown caller$/i.test(trimmed)) {
    return "there";
  }
  return trimmed.split(/\s+/)[0] ?? trimmed;
}
function buildCustomerConfirmationSms(input) {
  const customerName = formatCustomerDisplayName(input.lead.full_name);
  const companyName = input.company.company_name.trim() || "our roofing team";
  const priorityLabel = derivePhoneLeadPriorityLabel(input.fields);
  const lines = [
    `Hi ${customerName},`,
    "",
    `Thanks for contacting ${companyName}.`,
    "",
    "We've received your roofing request and someone from our team will review it shortly.",
    "",
    "If this is an emergency involving active water intrusion or immediate safety concerns, please call us immediately."
  ];
  if (hasText3(input.fields.appointment_preference)) {
    lines.push(
      "",
      "Requested appointment:",
      input.fields.appointment_preference.trim()
    );
  }
  if (priorityLabel === "Emergency") {
    lines.push(
      "",
      "Our team has marked your request as HIGH PRIORITY and will reach out as quickly as possible."
    );
  }
  lines.push("", "Thank you!");
  return lines.join("\n").slice(0, 1500);
}
function isCustomerConfirmationEnabled(smsFollowUpEnabled) {
  return smsFollowUpEnabled;
}

// ../../lib/customer-confirmation-sms.ts
var CUSTOMER_PHONE_AI_CONFIRMATION_KIND = "customer_phone_ai_confirmation";
var MAX_CUSTOMER_CONFIRMATION_ATTEMPTS = 3;
var RETRY_DELAYS_MS2 = [0, 750, 2e3];
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function redactCallSid2(callSid) {
  if (callSid.length <= 8) {
    return callSid;
  }
  return `${callSid.slice(0, 4)}...${callSid.slice(-4)}`;
}
function redactPhone2(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) {
    return "***";
  }
  return `***${digits.slice(-4)}`;
}
async function recordCustomerConfirmationState(callSid, input) {
  const supabase = createServiceClient();
  if (!supabase) {
    return;
  }
  await supabase.from("call_sessions").update({
    customer_confirmation_status: input.status,
    customer_confirmation_attempts: input.attempts,
    customer_confirmation_last_error: input.error ?? null,
    ...input.status === "sent" ? { customer_confirmation_sent_at: (/* @__PURE__ */ new Date()).toISOString() } : {}
  }).eq("twilio_call_sid", callSid);
}
async function logCustomerConfirmationActivity(companyId, leadId, summary, metadata) {
  const supabase = createServiceClient();
  if (!supabase) {
    return;
  }
  try {
    await createActivity(supabase, {
      companyId,
      leadId,
      activityType: "notification_queued",
      summary,
      metadata
    });
  } catch (error) {
    console.error("Failed to record customer confirmation activity:", error);
  }
}
async function loadCompany2(companyId) {
  const supabase = createServiceClient();
  if (!supabase) {
    return null;
  }
  const { data, error } = await supabase.from("companies").select("*").eq("id", companyId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}
async function loadLead2(leadId, companyId) {
  const supabase = createServiceClient();
  if (!supabase) {
    return null;
  }
  const { data, error } = await supabase.from("leads").select("*").eq("id", leadId).eq("company_id", companyId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}
async function sendCustomerConfirmationSmsIfNeeded(input) {
  const session = input.session;
  const leadId = input.leadId;
  if (!leadId || !session.company_id) {
    return { status: "skipped", reason: "Missing lead or company context." };
  }
  if (session.customer_confirmation_status === "sent") {
    return { status: "already_sent" };
  }
  const supabase = createServiceClient();
  if (!supabase) {
    return {
      status: "failed",
      error: "Supabase service client is not configured.",
      attempts: 0
    };
  }
  const existing = await getEmployeeNotificationForLead(
    supabase,
    leadId,
    "sms",
    CUSTOMER_PHONE_AI_CONFIRMATION_KIND
  );
  if (existing && (existing.status === "sent" || existing.status === "simulated")) {
    await recordCustomerConfirmationState(session.twilio_call_sid, {
      status: "sent",
      attempts: session.customer_confirmation_attempts ?? 0,
      error: null
    });
    return { status: "already_sent" };
  }
  const company = await loadCompany2(session.company_id);
  if (!company) {
    return { status: "skipped", reason: "Company not found." };
  }
  const settings = await getBusinessSettingsByCompanyId(supabase, company.id);
  if (!isCustomerConfirmationEnabled(settings?.sms_follow_up_enabled ?? false)) {
    await recordCustomerConfirmationState(session.twilio_call_sid, {
      status: "skipped",
      attempts: session.customer_confirmation_attempts ?? 0,
      error: "Customer confirmation SMS is disabled in business settings."
    });
    return {
      status: "skipped",
      reason: "Customer confirmation SMS is disabled in business settings."
    };
  }
  const lead = await loadLead2(leadId, session.company_id);
  if (!lead) {
    return { status: "skipped", reason: "Lead not found." };
  }
  const fields = input.fields ?? session.collected_fields ?? {};
  const customerPhone = resolveCustomerPhone(
    lead,
    fields,
    session.caller_phone
  );
  if (!customerPhone) {
    await recordCustomerConfirmationState(session.twilio_call_sid, {
      status: "skipped",
      attempts: session.customer_confirmation_attempts ?? 0,
      error: "No valid customer phone number available."
    });
    return {
      status: "skipped",
      reason: "No valid customer phone number available."
    };
  }
  const message = buildCustomerConfirmationSms({
    lead,
    company,
    fields
  });
  const startingAttempts = session.customer_confirmation_attempts ?? 0;
  const isRetry = startingAttempts > 0;
  let lastError = "Customer confirmation SMS failed.";
  for (let attempt = 1; attempt <= MAX_CUSTOMER_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const totalAttempts = startingAttempts + attempt;
    const delayMs = RETRY_DELAYS_MS2[attempt - 1] ?? 2e3;
    if (delayMs > 0) {
      await sleep2(delayMs);
    }
    const existingNotification = await getEmployeeNotificationForLead(
      supabase,
      leadId,
      "sms",
      CUSTOMER_PHONE_AI_CONFIRMATION_KIND
    );
    if (existingNotification && (existingNotification.status === "sent" || existingNotification.status === "simulated")) {
      await recordCustomerConfirmationState(session.twilio_call_sid, {
        status: "sent",
        attempts: totalAttempts,
        error: null
      });
      return { status: "already_sent" };
    }
    await recordCustomerConfirmationState(session.twilio_call_sid, {
      status: "pending",
      attempts: totalAttempts,
      error: null
    });
    if (attempt === 1 && !isRetry) {
      await logCustomerConfirmationActivity(
        session.company_id,
        leadId,
        "Customer confirmation queued",
        {
          callSid: redactCallSid2(session.twilio_call_sid),
          conversationId: session.id,
          notification_kind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND
        }
      );
    }
    try {
      const smsResult = await sendTwilioSms(customerPhone, message);
      const status = smsResult.delivered ? "sent" : "simulated";
      if (existingNotification) {
        await supabase.from("notifications").update({
          recipient: customerPhone,
          message,
          status,
          sent_at: smsResult.delivered ? (/* @__PURE__ */ new Date()).toISOString() : null,
          error_message: smsResult.delivered ? null : smsResult.reason
        }).eq("id", existingNotification.id);
      } else {
        await createEmployeeNotificationRecord(supabase, {
          companyId: session.company_id,
          leadId,
          channel: "sms",
          recipient: customerPhone,
          message,
          notificationKind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
          status,
          sentAt: smsResult.delivered ? (/* @__PURE__ */ new Date()).toISOString() : null,
          errorMessage: smsResult.delivered ? null : smsResult.reason
        });
      }
      await recordCustomerConfirmationState(session.twilio_call_sid, {
        status: "sent",
        attempts: totalAttempts,
        error: null
      });
      await logCustomerConfirmationActivity(
        session.company_id,
        leadId,
        isRetry ? "Customer confirmation retry succeeded" : "Customer confirmation sent",
        {
          callSid: redactCallSid2(session.twilio_call_sid),
          recipient: redactPhone2(customerPhone),
          delivery: status,
          notification_kind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND
        }
      );
      console.info(
        JSON.stringify({
          event: "customer_confirmation_sent",
          callSid: redactCallSid2(session.twilio_call_sid),
          leadId,
          delivery: status
        })
      );
      return { status: "sent" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      try {
        if (existingNotification) {
          await supabase.from("notifications").update({
            recipient: customerPhone,
            message,
            status: "failed",
            error_message: lastError
          }).eq("id", existingNotification.id);
        } else {
          await createEmployeeNotificationRecord(supabase, {
            companyId: session.company_id,
            leadId,
            channel: "sms",
            recipient: customerPhone,
            message,
            notificationKind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND,
            status: "failed",
            errorMessage: lastError
          });
        }
      } catch {
      }
      console.error(
        JSON.stringify({
          event: "customer_confirmation_failed",
          callSid: redactCallSid2(session.twilio_call_sid),
          leadId,
          attempt: totalAttempts,
          errorMessage: lastError
        })
      );
    }
  }
  await recordCustomerConfirmationState(session.twilio_call_sid, {
    status: "failed",
    attempts: startingAttempts + MAX_CUSTOMER_CONFIRMATION_ATTEMPTS,
    error: lastError
  });
  await logCustomerConfirmationActivity(
    session.company_id,
    leadId,
    "Customer confirmation failed",
    {
      callSid: redactCallSid2(session.twilio_call_sid),
      errorMessage: lastError,
      notification_kind: CUSTOMER_PHONE_AI_CONFIRMATION_KIND
    }
  );
  return {
    status: "failed",
    error: lastError,
    attempts: startingAttempts + MAX_CUSTOMER_CONFIRMATION_ATTEMPTS
  };
}

// ../../lib/call-lead-crm.ts
var MAX_CRM_LEAD_ATTEMPTS = 3;
var RETRY_DELAYS_MS3 = [0, 500, 1500];
function sleep3(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function hasText4(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isAffirmative2(value) {
  return hasText4(value) && /^(yes|yeah|yep|yup|true|correct|started|filed|active)/i.test(value.trim());
}
function shouldCreateCrmLeadFromSession(session) {
  if (session.status !== "completed") {
    return false;
  }
  if (session.lead_id) {
    return false;
  }
  const fields = session.collected_fields ?? {};
  return fields.summary_confirmed === true;
}
function derivePhoneLeadPriorityLabel(fields) {
  const urgency = fields.urgency?.toLowerCase() ?? "";
  if (fields.emergency_acknowledged === true || urgency.includes("emergency") || urgency.includes("asap")) {
    return "Emergency";
  }
  if (isAffirmative2(fields.active_leak) || urgency.includes("urgent") || urgency.includes("today") || urgency.includes("right away")) {
    return "High";
  }
  if (isAffirmative2(fields.storm_damage) || fields.project_type?.toLowerCase().includes("storm") || isAffirmative2(fields.insurance_claim)) {
    return "Medium";
  }
  return "Low";
}
function mapCallProjectType(value) {
  if (!hasText4(value)) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("storm")) {
    return "storm_damage";
  }
  if (normalized.includes("repair")) {
    return "repair";
  }
  if (normalized.includes("replace")) {
    return "replacement";
  }
  if (normalized.includes("inspect")) {
    return "inspection";
  }
  if (normalized === "repair" || normalized === "replacement" || normalized === "inspection" || normalized === "storm_damage" || normalized === "other") {
    return normalized;
  }
  return "other";
}
function parseCallInsuranceClaim(value) {
  if (!hasText4(value)) {
    return false;
  }
  return isAffirmative2(value);
}
function buildPhoneLeadDescription(session, fields) {
  const summary = buildCrmCallSummary(fields);
  const priorityLabel = derivePhoneLeadPriorityLabel(fields);
  const lines = [summary];
  if (hasText4(fields.appointment_preference)) {
    lines.push(`Requested appointment: ${fields.appointment_preference.trim()}`);
  }
  lines.push(
    `[Priority: ${priorityLabel}]`,
    "[Source: Phone AI]",
    `[CallSid: ${session.twilio_call_sid}]`,
    `[ConversationId: ${session.id}]`
  );
  return lines.filter(Boolean).join("\n");
}
function prepareCallSessionFieldsForCrm(session) {
  const fields = { ...session.collected_fields ?? {} };
  const priorityLabel = derivePhoneLeadPriorityLabel(fields);
  return {
    ...fields,
    priority_label: priorityLabel,
    crm_summary: buildCrmCallSummary(fields)
  };
}
function redactCallSid3(callSid) {
  if (callSid.length <= 8) {
    return callSid;
  }
  return `${callSid.slice(0, 4)}...${callSid.slice(-4)}`;
}
async function recordCrmLeadAttempt(callSid, input) {
  const supabase = createServiceClient();
  if (!supabase) {
    return;
  }
  await supabase.from("call_sessions").update({
    crm_lead_status: input.status,
    crm_lead_attempts: input.attempts,
    crm_lead_last_error: input.error ?? null,
    ...input.leadId ? {
      lead_id: input.leadId,
      crm_lead_created_at: (/* @__PURE__ */ new Date()).toISOString()
    } : {}
  }).eq("twilio_call_sid", callSid);
}
async function createLeadViaRpc(callSid) {
  const supabase = createServiceClient();
  if (!supabase) {
    throw new Error("Supabase service client is not configured.");
  }
  const { data, error } = await supabase.rpc(
    "create_phone_ai_lead_from_call_session",
    {
      p_twilio_call_sid: callSid
    }
  );
  if (error) {
    throw error;
  }
  return data ?? null;
}
async function createLeadViaDirectInsert(session) {
  const supabase = createServiceClient();
  if (!supabase) {
    throw new Error("Supabase service client is not configured.");
  }
  const fields = prepareCallSessionFieldsForCrm(session);
  const description = buildPhoneLeadDescription(session, fields);
  const fullName = fields.full_name?.trim() || "Unknown caller";
  const phone = fields.callback_phone?.trim() || session.caller_phone?.trim() || null;
  const { data: lead, error: leadError } = await supabase.from("leads").insert({
    company_id: session.company_id,
    full_name: fullName,
    phone,
    email: null,
    address_line_1: fields.address?.trim() || null,
    city: null,
    state: null,
    postal_code: null,
    source: "ai_phone",
    status: "new",
    project_type: mapCallProjectType(fields.project_type),
    description,
    insurance_claim: parseCallInsuranceClaim(fields.insurance_claim),
    appointment_at: null
  }).select("id").single();
  if (leadError || !lead) {
    throw leadError ?? new Error("Lead insert returned no data.");
  }
  const transcript = session.transcript ?? [];
  const { error: transcriptError } = await supabase.from("phone_call_transcripts").upsert(
    {
      call_session_id: session.id,
      lead_id: lead.id,
      company_id: session.company_id,
      twilio_call_sid: session.twilio_call_sid,
      transcript,
      ai_summary: fields.crm_summary ?? buildCrmCallSummary(fields),
      metadata: {
        priority_label: fields.priority_label,
        conversation_id: session.id,
        source: "Phone AI"
      }
    },
    { onConflict: "call_session_id" }
  );
  if (transcriptError) {
    console.error("Failed to store phone call transcript:", transcriptError.message);
  }
  const activityRows = [
    {
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "call_received",
      summary: "Incoming AI Phone Call",
      metadata: {
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id,
        source: "Phone AI"
      }
    },
    {
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "lead_created",
      summary: "Lead Created",
      metadata: {
        source: "ai_phone",
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id
      }
    },
    {
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "call_received",
      summary: "Summary Generated",
      metadata: {
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id,
        event: "summary_generated"
      }
    },
    {
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "call_received",
      summary: "Customer Confirmed",
      metadata: {
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id,
        event: "customer_confirmed"
      }
    }
  ];
  if (hasText4(fields.appointment_preference)) {
    activityRows.push({
      company_id: session.company_id,
      lead_id: lead.id,
      activity_type: "appointment_booked",
      summary: "Appointment Requested",
      metadata: {
        appointment_preference: fields.appointment_preference.trim(),
        twilio_call_sid: session.twilio_call_sid,
        conversation_id: session.id
      }
    });
  }
  const { error: activityError } = await supabase.from("activity_history").insert(activityRows);
  if (activityError) {
    console.error("Failed to create lead activities:", activityError.message);
  }
  await supabase.from("call_sessions").update({
    lead_id: lead.id,
    crm_lead_status: "created",
    crm_lead_created_at: (/* @__PURE__ */ new Date()).toISOString(),
    crm_lead_last_error: null
  }).eq("twilio_call_sid", session.twilio_call_sid);
  return lead.id;
}
async function runPostLeadAutomations(session, leadId) {
  const refreshedSession = await getCallSessionBySid(session.twilio_call_sid);
  const workingSession = refreshedSession ?? { ...session, lead_id: leadId };
  try {
    await notifyEmployeesOfPhoneAiLeadIfNeeded({
      session: workingSession,
      leadId
    });
  } catch (notificationError) {
    console.error("Employee notification after CRM lead creation failed:", notificationError);
  }
  try {
    await sendCustomerConfirmationSmsIfNeeded({
      session: workingSession,
      leadId
    });
  } catch (confirmationError) {
    console.error("Customer confirmation SMS after CRM lead creation failed:", confirmationError);
  }
}
async function createCrmLeadFromCallSession(session) {
  if (!shouldCreateCrmLeadFromSession(session)) {
    await recordCrmLeadAttempt(session.twilio_call_sid, {
      status: "skipped",
      attempts: session.crm_lead_attempts ?? 0
    });
    return {
      status: "skipped",
      reason: "Call was not confirmed or is not eligible for CRM lead creation."
    };
  }
  if (session.lead_id) {
    await runPostLeadAutomations(session, session.lead_id);
    return { status: "already_created", leadId: session.lead_id };
  }
  const preparedFields = prepareCallSessionFieldsForCrm(session);
  const preparedSession = {
    ...session,
    collected_fields: preparedFields
  };
  await updateCallSession({
    callSid: session.twilio_call_sid,
    collectedFields: preparedFields
  });
  let lastError = "Unknown CRM lead creation error.";
  const startingAttempts = session.crm_lead_attempts ?? 0;
  for (let attempt = 1; attempt <= MAX_CRM_LEAD_ATTEMPTS; attempt += 1) {
    const totalAttempts = startingAttempts + attempt;
    const delayMs = RETRY_DELAYS_MS3[attempt - 1] ?? 1500;
    if (delayMs > 0) {
      await sleep3(delayMs);
    }
    try {
      await recordCrmLeadAttempt(session.twilio_call_sid, {
        status: "pending",
        attempts: totalAttempts,
        error: null
      });
      let leadId = null;
      try {
        leadId = await createLeadViaRpc(session.twilio_call_sid);
      } catch (rpcError) {
        const message = rpcError instanceof Error ? rpcError.message : String(rpcError);
        if (message.includes("Could not find the function")) {
          leadId = await createLeadViaDirectInsert(preparedSession);
        } else {
          throw rpcError;
        }
      }
      if (!leadId) {
        return {
          status: "skipped",
          reason: "CRM lead creation skipped by database rules."
        };
      }
      console.info(
        JSON.stringify({
          event: "crm_lead_created",
          callSid: redactCallSid3(session.twilio_call_sid),
          leadId,
          attempts: totalAttempts
        })
      );
      await runPostLeadAutomations(session, leadId);
      return { status: "created", leadId };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          event: "crm_lead_creation_failed",
          callSid: redactCallSid3(session.twilio_call_sid),
          attempt: totalAttempts,
          errorMessage: lastError
        })
      );
      await recordCrmLeadAttempt(session.twilio_call_sid, {
        status: "failed",
        attempts: totalAttempts,
        error: lastError
      });
    }
  }
  return {
    status: "failed",
    error: lastError,
    attempts: startingAttempts + MAX_CRM_LEAD_ATTEMPTS
  };
}

// ../../lib/twilio/voice-phrases.ts
var OPENING_QUESTION = "What's going on with the roof?";
var OPENING_GREETING = "Hi, thanks for calling Beau's Roofing. I'm the AI assistant here to help. " + OPENING_QUESTION;
var OPENING_RETRY_PROMPT = `I didn't catch that. ${OPENING_QUESTION}`;
function isExplicitCallerHangupDuringIntake(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(goodbye|good bye|bye|bye bye)\b/.test(normalized);
}
function isConfirmationPhrase(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(yes|yeah|yep|yup|correct|right|exactly|sure|absolutely|sounds good|sound good|that'?s right|thats right|that is correct|all good|perfect|ok(?:ay)?)\b/.test(
    normalized
  ) || normalized === "uh huh";
}
function isCorrectionPhrase(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(no|nope|nah|not quite|incorrect|wrong|that'?s wrong|thats wrong|not right|actually)\b/.test(
    normalized
  );
}

// ../../lib/call-intelligence.ts
var STAGE_FIELD_KEYS = {
  problem: "problem_description",
  full_name: "full_name",
  callback_phone: "callback_phone",
  address: "address",
  project_type: "project_type",
  active_leak: "active_leak",
  storm_damage: "storm_damage",
  insurance_claim: "insurance_claim",
  urgency: "urgency",
  appointment: "appointment_preference",
  additional_notes: "additional_notes"
};
var INTERRUPTION_PREFIX_PATTERN = /^(actually|wait|hold on|hang on|one second|one sec|sorry)[,.]?\s+/i;
var CORRECTION_PREFIX_PATTERN = /^(no|actually|wait|not|correction)[,.]?\s+/i;
var EMERGENCY_PATTERN = /\b(tree through|through the roof|roof collapse|collapsed|caved in|water pouring|pouring in|ceiling leaking badly|electrical hazard|spark|storm happening now|active storm|emergency|urgent|asap)\b/i;
function stripInterruptionPrefix(speech) {
  return speech.replace(INTERRUPTION_PREFIX_PATTERN, "").trim();
}
function hasCorrectionIntent(speech) {
  const normalized = speech.trim().toLowerCase();
  return CORRECTION_PREFIX_PATTERN.test(normalized) || /\b(not|actually|instead|rather|meant|correction|wrong)\b/.test(normalized);
}
function detectEmergency(speech) {
  return EMERGENCY_PATTERN.test(speech.toLowerCase()) || /water.*(inside|coming in|pouring)|ceiling.*leak/i.test(speech.toLowerCase());
}
function applyTargetedCorrection(fields, speech, currentStage, callerPhone) {
  const cleaned = stripInterruptionPrefix(speech).replace(CORRECTION_PREFIX_PATTERN, "").trim();
  const text = cleaned || speech.trim();
  const lower = text.toLowerCase();
  const updated = { ...fields };
  const nameMatch = text.match(
    /(?:name is|my name is|i'?m|this is|it's|it is|call me)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i
  );
  if (nameMatch?.[1]) {
    updated.full_name = nameMatch[1].trim();
    return { fields: updated, updated: true, field: "full_name" };
  }
  const firstNameMatch = text.match(
    /\b(?:my )?first name is\s+([A-Za-z][A-Za-z'-]+)/i
  );
  if (firstNameMatch?.[1]) {
    const lastName = updated.full_name?.trim().split(/\s+/).slice(1).join(" ");
    updated.full_name = lastName ? `${firstNameMatch[1].trim()} ${lastName}` : firstNameMatch[1].trim();
    return { fields: updated, updated: true, field: "full_name" };
  }
  const lastNameMatch = text.match(
    /\b(?:my )?last name is\s+([A-Za-z][A-Za-z'-]+)/i
  );
  if (lastNameMatch?.[1]) {
    const firstName = updated.full_name?.trim().split(/\s+/)[0] ?? "";
    updated.full_name = firstName ? `${firstName} ${lastNameMatch[1].trim()}` : lastNameMatch[1].trim();
    return { fields: updated, updated: true, field: "full_name" };
  }
  if (/\b(last name|surname)\b.*\b(wrong|incorrect)\b/i.test(lower)) {
    updated.name_pending_confirmation = void 0;
    updated.full_name = void 0;
    updated.name_awaiting_repeat = true;
    return { fields: updated, updated: true, field: "full_name" };
  }
  const addressMatch = text.match(
    /\b(?:address is|at|to)\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i
  ) ?? text.match(
    /(?:change|update|correct|fix).*?(?:address|location|property).*?(?:to|is)\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i
  );
  if (addressMatch?.[1]) {
    updated.address = addressMatch[1].trim();
    return { fields: updated, updated: true, field: "address" };
  }
  const phone = text.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/
  );
  if (phone) {
    const digits = phone[0].replace(/\D/g, "").slice(-10);
    updated.callback_phone = digits;
    return { fields: updated, updated: true, field: "callback_phone" };
  }
  if (/wind damage|\bwind\b/i.test(lower)) {
    updated.project_type = "wind damage";
    updated.storm_damage = "yes";
    if (!updated.problem_description?.toLowerCase().includes("wind")) {
      updated.problem_description = text;
    }
    return { fields: updated, updated: true, field: "project_type" };
  }
  if (/hail/i.test(lower)) {
    updated.project_type = "storm damage";
    updated.storm_damage = "yes";
    return { fields: updated, updated: true, field: "project_type" };
  }
  if (/appointment|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d\s*(am|pm)/i.test(
    text
  )) {
    updated.appointment_preference = text;
    return { fields: updated, updated: true, field: "appointment_preference" };
  }
  if (/^(yes|yeah|yep|no|nope|nah)\b/i.test(lower) && fields.insurance_claim) {
    updated.insurance_claim = /^(yes|yeah|yep)\b/i.test(lower) ? "yes" : "no";
    return { fields: updated, updated: true, field: "insurance_claim" };
  }
  if (hasCorrectionIntent(speech) && text.length > 0) {
    if (currentStage === "wrap_up" || fields.summary_delivered) {
      return { fields, updated: false };
    }
    const fieldKey = STAGE_FIELD_KEYS[currentStage];
    updated[fieldKey] = text;
    return { fields: updated, updated: true, field: fieldKey };
  }
  if (callerPhone && /same number|this number/i.test(lower)) {
    updated.callback_phone = callerPhone;
    return { fields: updated, updated: true, field: "callback_phone" };
  }
  return { fields, updated: false };
}

// ../../lib/twilio/company.ts
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}
function phoneMatchKeys(phone) {
  const digits = phone.replace(/\D/g, "");
  const keys = /* @__PURE__ */ new Set();
  if (!digits) {
    return keys;
  }
  keys.add(digits);
  if (digits.length >= 10) {
    keys.add(digits.slice(-10));
  }
  if (digits.length === 10) {
    keys.add(`1${digits}`);
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    keys.add(digits.slice(1));
  }
  return keys;
}
function phonesMatch(phoneA, phoneB) {
  const keysA = phoneMatchKeys(phoneA);
  const keysB = phoneMatchKeys(phoneB);
  for (const key of keysA) {
    if (keysB.has(key)) {
      return true;
    }
  }
  return false;
}
async function loadCompaniesWithPhones(supabase) {
  const { data, error } = await supabase.from("companies").select("id, business_phone");
  if (error) {
    throw error;
  }
  return data ?? [];
}
async function companyExists(supabase, companyId) {
  const { data, error } = await supabase.from("companies").select("id").eq("id", companyId).maybeSingle();
  if (error) {
    throw error;
  }
  return Boolean(data?.id);
}
function matchCompanyByPhone(companies, calledPhone) {
  for (const company of companies) {
    if (company.business_phone && phonesMatch(company.business_phone, calledPhone)) {
      return company.id;
    }
  }
  return null;
}
function getConfiguredTwilioPhone() {
  return process.env.TWILIO_PHONE_NUMBER?.trim() ?? null;
}
function getConfiguredDefaultCompanyId() {
  return process.env.TWILIO_DEFAULT_COMPANY_ID?.trim() ?? null;
}
async function resolveConfiguredDefaultCompany(supabase, calledPhone) {
  const defaultCompanyId = getConfiguredDefaultCompanyId();
  if (!defaultCompanyId) {
    return null;
  }
  const configuredTwilioPhone = getConfiguredTwilioPhone();
  if (configuredTwilioPhone && calledPhone && !phonesMatch(configuredTwilioPhone, calledPhone)) {
    return null;
  }
  if (!await companyExists(supabase, defaultCompanyId)) {
    console.error(
      "TWILIO_DEFAULT_COMPANY_ID is set but does not match an existing company."
    );
    return null;
  }
  return defaultCompanyId;
}
function resolveSingleCompanyFallback(companies) {
  if (companies.length !== 1) {
    return null;
  }
  return companies[0]?.id ?? null;
}
async function lookupCompanyIdByCalledPhone(supabase, calledPhone) {
  const companies = await loadCompaniesWithPhones(supabase);
  const trimmedCalledPhone = calledPhone.trim();
  if (trimmedCalledPhone) {
    const matchedCompanyId = matchCompanyByPhone(
      companies,
      trimmedCalledPhone
    );
    if (matchedCompanyId) {
      return matchedCompanyId;
    }
  }
  const configuredCompanyId = await resolveConfiguredDefaultCompany(
    supabase,
    trimmedCalledPhone
  );
  if (configuredCompanyId) {
    return configuredCompanyId;
  }
  return resolveSingleCompanyFallback(companies);
}
async function resolveCompanyForTwilioCall(calledPhone) {
  const supabase = createServiceClient();
  if (!supabase) {
    console.error(
      "Twilio company lookup failed: SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL is not configured."
    );
    return null;
  }
  try {
    const companyId = await lookupCompanyIdByCalledPhone(
      supabase,
      calledPhone
    );
    if (!companyId) {
      console.error(
        "Twilio company lookup failed: no company matched called phone.",
        JSON.stringify({ calledPhone: normalizePhone(calledPhone) || "missing" })
      );
    }
    return companyId;
  } catch (error) {
    console.error("Twilio company lookup failed:", error);
    return null;
  }
}

// ../../lib/call-sessions.ts
function createTranscriptEntry(role, content) {
  return {
    role,
    content,
    at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function ensureCallSessionForTwilioCall(input) {
  if (!input.callSid) {
    return null;
  }
  const existingSession = await getCallSessionBySid(input.callSid);
  if (existingSession) {
    return existingSession;
  }
  const companyId = await resolveCompanyForTwilioCall(input.calledPhone);
  if (!companyId) {
    return null;
  }
  return getOrCreateCallSession({
    callSid: input.callSid,
    companyId,
    callerPhone: input.callerPhone,
    calledPhone: input.calledPhone
  });
}
async function getCallSessionBySid(callSid) {
  const supabase = createServiceClient();
  if (!supabase || !callSid) {
    return null;
  }
  const { data, error } = await supabase.from("call_sessions").select("*").eq("twilio_call_sid", callSid).maybeSingle();
  if (error) {
    console.error("Failed to load call session:", error.message);
    return null;
  }
  return data ?? null;
}
async function getOrCreateCallSession(input) {
  const supabase = createServiceClient();
  if (!supabase || !input.callSid || !input.companyId) {
    return null;
  }
  const { data, error } = await supabase.rpc("get_or_create_call_session", {
    p_twilio_call_sid: input.callSid,
    p_company_id: input.companyId,
    p_caller_phone: input.callerPhone ?? null,
    p_called_phone: input.calledPhone ?? null
  });
  if (error) {
    console.error("Failed to create call session:", error.message);
    return null;
  }
  return data;
}
async function updateCallSession(input) {
  const supabase = createServiceClient();
  if (!supabase || !input.callSid) {
    return null;
  }
  const { data, error } = await supabase.rpc("update_call_session", {
    p_twilio_call_sid: input.callSid,
    p_current_question: input.currentQuestion ?? null,
    p_collected_fields: input.collectedFields ?? null,
    p_transcript_entry: input.transcriptEntry ?? null,
    p_status: null,
    p_attempt_count: input.attemptCount ?? null
  });
  if (error) {
    console.error("Failed to update call session:", error.message);
    return null;
  }
  return data;
}
async function completeCallSession(callSid, status = "completed") {
  const supabase = createServiceClient();
  if (!supabase || !callSid) {
    return null;
  }
  const { data, error } = await supabase.rpc("complete_call_session", {
    p_twilio_call_sid: callSid,
    p_status: status
  });
  if (error) {
    console.error("Failed to complete call session:", error.message);
    return null;
  }
  const session = data;
  if (status === "completed" && shouldCreateCrmLeadFromSession(session) && !session.lead_id && session.crm_lead_status !== "created") {
    try {
      const result = await createCrmLeadFromCallSession(session);
      if (result.status === "failed") {
        console.error(
          JSON.stringify({
            event: "crm_lead_creation_exhausted_retries",
            callSid,
            attempts: result.attempts,
            errorMessage: result.error
          })
        );
      }
    } catch (crmError) {
      console.error("Unexpected CRM lead creation error:", crmError);
    }
  }
  return session;
}

// ../../lib/call-name-capture.ts
var MAX_NAME_CONFIRMATION_ATTEMPTS = 3;
var NAME_PREFIX_PATTERN = /^(?:my name is|name is|this is|i am|i'm|it's|it is|call me)\s+/i;
var CORRECTION_PREFIX_PATTERN2 = /^(no|actually|wait|not|correction)[,.]?\s+/i;
function hasText5(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isAwaitingNameConfirmation(fields) {
  return hasText5(fields.name_pending_confirmation) && !hasText5(fields.full_name);
}
function normalizePersonName(name) {
  return name.trim().split(/\s+/).map(
    (part) => part.split("-").map((segment) => {
      if (!segment) {
        return segment;
      }
      return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
    }).join("-")
  ).join(" ");
}
function parseNameFromSpeech(text) {
  const cleaned = stripInterruptionPrefix(text.trim()).replace(CORRECTION_PREFIX_PATTERN2, "").trim();
  if (!cleaned) {
    return null;
  }
  const nonNameLeadIn = /^(?:i'?m|i am)\s+(?:calling(?:\s+(?:about|for|regarding))?|call(?:ing)?\s+(?:about|for|regarding)|having|needing|looking(?:\s+for)?|wondering(?:\s+(?:about|if))?|trying(?:\s+to)?|reporting|asking(?:\s+about)?)\b/i;
  if (nonNameLeadIn.test(cleaned)) {
    return null;
  }
  const positivePatterns = [
    /\b(?:my name is|name is)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,3})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
    /\bthis is\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
    /\b(?:it'?s|it is)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i,
    /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})(?=\s*,\s*and\b)/i,
    /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)?)(?=\s*,)/i,
    /\b(?:i am|i'm)\s+([A-Za-z][A-Za-z'-]+)\s+and\b/i,
    /\b(?:call me)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})(?=\s+(?:and|with|from|at|who|calling|about|for)\b|[,.]|$)/i
  ];
  for (const pattern of positivePatterns) {
    const match = cleaned.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate) {
      continue;
    }
    const refined = refineParsedNameCandidate(candidate);
    if (refined) {
      return normalizePersonName(refined);
    }
  }
  const withoutIntro = cleaned.replace(NAME_PREFIX_PATTERN, "").replace(/[.!?]+$/g, "").trim();
  const directMatch = withoutIntro.match(
    /^([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})$/
  );
  if (directMatch?.[1] && isPlausibleParsedName(directMatch[1])) {
    return normalizePersonName(directMatch[1]);
  }
  return null;
}
function refineParsedNameCandidate(candidate) {
  const words = candidate.trim().split(/\s+/).filter(Boolean);
  for (let length = words.length; length >= 1; length -= 1) {
    const prefix = words.slice(0, length).join(" ");
    if (isPlausibleParsedName(prefix)) {
      return prefix;
    }
  }
  return null;
}
function isPlausibleParsedName(name) {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 60 || /\d/.test(trimmed)) {
    return false;
  }
  const invalidExact = /^(calling|call|calling about|calling for|having|needing|looking|wondering|trying|reporting|asking|roof|roofing|damage|hail|storm|leak|shingles|insurance|claim|pictures|photos|appointment|today|tomorrow|yes|no|yeah|nope|yep|nah|correct|right)$/i;
  const words = trimmed.split(/\s+/);
  if (words.length === 0 || words.length > 4) {
    return false;
  }
  if (words.some((word) => invalidExact.test(word.toLowerCase()))) {
    return false;
  }
  if (/\b(hail|storm|roof|damage|leak|insurance|claim|appointment|pictures?|photos?)\b/i.test(
    trimmed
  )) {
    return false;
  }
  return /^[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3}$/.test(trimmed);
}
function buildNameConfirmationPrompt(name) {
  return `I heard ${name}. Is that correct?`;
}
function buildNameRepeatPrompt() {
  return "Sorry about that. Please say your first and last name again.";
}
function clearNameCaptureState(fields) {
  return {
    ...fields,
    name_pending_confirmation: void 0,
    name_raw_speech: void 0,
    name_awaiting_repeat: void 0,
    name_confirmation_attempts: void 0
  };
}
function acceptPendingName(fields) {
  const pending = fields.name_pending_confirmation?.trim();
  if (!pending) {
    return fields;
  }
  return clearNameCaptureState({
    ...fields,
    full_name: pending
  });
}
function beginNameConfirmation(fields, rawSpeech, parsedName) {
  return {
    ...fields,
    name_pending_confirmation: parsedName,
    name_raw_speech: rawSpeech.trim(),
    name_awaiting_repeat: false
  };
}
function incrementNameConfirmationAttempts(fields) {
  return {
    ...fields,
    name_confirmation_attempts: (fields.name_confirmation_attempts ?? 0) + 1
  };
}
function isNameOnlyCorrection(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /\b(last name|first name|surname|spelling)\b/.test(normalized) || /\bwith an? [a-z]\b/i.test(speech);
}
function processNameCaptureTurn(input) {
  const speech = input.speech.trim();
  let fields = { ...input.fields };
  let nameCorrected = false;
  if (isAwaitingNameConfirmation(fields)) {
    const pendingName = fields.name_pending_confirmation?.trim() ?? "";
    if (isConfirmationPhrase(speech) && !hasCorrectionIntent(speech) && !isCorrectionPhrase(speech)) {
      return {
        status: "accepted",
        fields: acceptPendingName(fields),
        replyText: null,
        nameConfirmationRequested: false,
        nameCorrected: false
      };
    }
    const correction = applyTargetedCorrection(
      fields,
      speech,
      "full_name"
    );
    if (correction.updated && correction.field === "full_name") {
      const correctedName = normalizePersonName(
        correction.fields.full_name ?? pendingName
      );
      return {
        status: "confirm",
        fields: beginNameConfirmation(fields, speech, correctedName),
        replyText: buildNameConfirmationPrompt(correctedName),
        nameConfirmationRequested: true,
        nameCorrected: true
      };
    }
    const parsedCorrection = parseNameFromSpeech(speech);
    if (parsedCorrection && (hasCorrectionIntent(speech) || isCorrectionPhrase(speech))) {
      nameCorrected = true;
      return {
        status: "confirm",
        fields: beginNameConfirmation(fields, speech, parsedCorrection),
        replyText: buildNameConfirmationPrompt(parsedCorrection),
        nameConfirmationRequested: true,
        nameCorrected: true
      };
    }
    if (isCorrectionPhrase(speech) || hasCorrectionIntent(speech) || isNameOnlyCorrection(speech)) {
      fields = incrementNameConfirmationAttempts({
        ...clearNameCaptureState(fields),
        name_awaiting_repeat: true
      });
      if ((fields.name_confirmation_attempts ?? 0) >= MAX_NAME_CONFIRMATION_ATTEMPTS) {
        return {
          status: "accepted",
          fields: acceptPendingName({
            ...fields,
            name_pending_confirmation: pendingName
          }),
          replyText: null,
          nameConfirmationRequested: false,
          nameCorrected: false
        };
      }
      return {
        status: "repeat",
        fields,
        replyText: buildNameRepeatPrompt(),
        nameConfirmationRequested: false,
        nameCorrected: true
      };
    }
    if (parsedCorrection && parsedCorrection.toLowerCase() !== pendingName.toLowerCase()) {
      return {
        status: "confirm",
        fields: beginNameConfirmation(fields, speech, parsedCorrection),
        replyText: buildNameConfirmationPrompt(parsedCorrection),
        nameConfirmationRequested: true,
        nameCorrected: true
      };
    }
    return {
      status: "confirm",
      fields,
      replyText: buildNameConfirmationPrompt(pendingName),
      nameConfirmationRequested: true,
      nameCorrected: false
    };
  }
  const parsedName = parseNameFromSpeech(speech);
  if (!parsedName) {
    fields = incrementNameConfirmationAttempts({
      ...fields,
      name_awaiting_repeat: true
    });
    if ((fields.name_confirmation_attempts ?? 0) >= MAX_NAME_CONFIRMATION_ATTEMPTS) {
      const fallbackName = normalizePersonName(speech);
      return {
        status: "accepted",
        fields: clearNameCaptureState({
          ...fields,
          full_name: fallbackName
        }),
        replyText: null,
        nameConfirmationRequested: false,
        nameCorrected: false
      };
    }
    return {
      status: "repeat",
      fields: clearNameCaptureState({
        ...fields,
        name_awaiting_repeat: true
      }),
      replyText: buildNameRepeatPrompt(),
      nameConfirmationRequested: false,
      nameCorrected: false
    };
  }
  fields = beginNameConfirmation(fields, speech, parsedName);
  return {
    status: "confirm",
    fields,
    replyText: buildNameConfirmationPrompt(parsedName),
    nameConfirmationRequested: true,
    nameCorrected: false
  };
}

// src/orchestrator/safe-field-merge.ts
function preserveConfirmedFieldState(before, after) {
  const callbackUnchanged = (before.callback_phone?.trim() ?? "") === (after.callback_phone?.trim() ?? "");
  const addressUnchanged = (before.address?.trim() ?? "") === (after.address?.trim() ?? "");
  const nameUnchanged = (before.full_name?.trim() ?? "") === (after.full_name?.trim() ?? "");
  return {
    ...after,
    callback_phone_confirmed: callbackUnchanged && before.callback_phone_confirmed === true ? true : after.callback_phone_confirmed,
    address_confirmed: addressUnchanged && before.address_confirmed === true ? true : after.address_confirmed,
    full_name: nameUnchanged ? before.full_name ?? after.full_name : after.full_name,
    caller_name_declined: nameUnchanged ? before.caller_name_declined : after.caller_name_declined,
    caller_name_unavailable: nameUnchanged ? before.caller_name_unavailable : after.caller_name_unavailable
  };
}

// src/orchestrator/multi-field-extraction.ts
function hasValue6(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isShortPendingStyleAnswer(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  return /^(yes|yeah|yep|yup|correct|right|no|nope|nah|not yet|i did|i have|i haven't|i havent|haven't|havent)$/i.test(
    normalized
  );
}
function shouldExtractCallbackPhone(pendingQuestion, speech) {
  if (pendingQuestion === "callback_phone" || pendingQuestion === "callback_confirmation") {
    return true;
  }
  return !isShortPendingStyleAnswer(speech);
}
function extractInsuranceClaim(speech, pending) {
  if (allowsBooleanDirectAnswer(pending, "insurance_claim")) {
    return parseExplicitBoolean(speech);
  }
  if (/\b(insurance|claim)\b/i.test(speech)) {
    return parseExplicitBoolean(speech);
  }
  return null;
}
function extractAdjusterContact(speech, pending) {
  if (allowsBooleanDirectAnswer(pending, "adjuster_contacted")) {
    return parseExplicitBoolean(speech);
  }
  if (/\badjuster\b/i.test(speech)) {
    return parseExplicitBoolean(speech);
  }
  return null;
}
function extractActiveLeak(speech, pending) {
  if (allowsBooleanDirectAnswer(pending, "active_leak")) {
    return parseExplicitBoolean(speech);
  }
  if (/\b(leak|water|drip|flooding|getting inside|active leak)\b/i.test(speech)) {
    const parsed = parseExplicitBoolean(speech);
    if (parsed !== null) {
      return parsed;
    }
    if (/no.*(leak|water)|isn't.*(leak|water)|not.*(leak|water)/i.test(speech)) {
      return false;
    }
    if (/water.*(inside|getting in)|active leak|leaking inside/i.test(speech)) {
      return true;
    }
  }
  return null;
}
function extractAddressFromSpeech(speech) {
  const streetMatch = speech.match(
    /\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80}(?:\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|place|pl)\b)?/i
  );
  if (streetMatch && isPlausibleServiceAddress(streetMatch[0])) {
    return streetMatch[0].trim();
  }
  const atMatch = speech.match(/\bat\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,60})/i);
  const candidate = atMatch?.[1]?.trim();
  if (candidate && isPlausibleServiceAddress(candidate)) {
    return candidate;
  }
  return null;
}
function extractAllFieldsFromTranscript(speech, callerPhone, pendingQuestion = null) {
  const trimmed = speech.trim();
  if (!trimmed) {
    return {};
  }
  const extracted = {};
  if (isPendingCallReasonQuestion(pendingQuestion)) {
    const reason = normalizeCallReasonFromSpeech(trimmed);
    if (reason) {
      extracted.problem_description = reason;
    }
    const volunteeredName = extractExplicitCallerName(trimmed);
    if (volunteeredName) {
      extracted.full_name = volunteeredName;
    }
  } else {
    const explicitName = extractExplicitCallerName(trimmed);
    if (explicitName) {
      extracted.full_name = explicitName;
    }
    const damage = extractDamageOrCallReason(trimmed);
    if (damage) {
      extracted.problem_description = damage;
    }
  }
  const address = extractAddressFromSpeech(trimmed);
  if (address) {
    extracted.address = address;
  }
  const callbackPhone = shouldExtractCallbackPhone(pendingQuestion, trimmed) ? extractCallbackPhoneFromSpeech(trimmed, callerPhone, {
    allowAffirmativeReuse: allowsCallbackAffirmativeReuse(pendingQuestion)
  }) : null;
  if (callbackPhone) {
    extracted.callback_phone = callbackPhone;
  }
  const insurance = extractInsuranceClaim(trimmed, pendingQuestion);
  if (insurance !== null) {
    extracted.insurance_claim_started = insurance;
  }
  const adjuster = extractAdjusterContact(trimmed, pendingQuestion);
  if (adjuster !== null) {
    extracted.adjuster_contacted = adjuster;
  }
  const leak = extractActiveLeak(trimmed, pendingQuestion);
  if (leak !== null) {
    extracted.emergency_or_active_leak = leak;
  }
  if (detectEmergency(trimmed)) {
    extracted.urgency = extracted.urgency ?? "emergency";
    if (/water.*(inside|getting in|coming into)|active leak|leaking inside|flooding/i.test(trimmed)) {
      extracted.emergency_or_active_leak = extracted.emergency_or_active_leak ?? true;
      extracted.emergency_acknowledged = true;
    }
  }
  return extracted;
}
function mergeExtractedFields(fields, extracted) {
  let updated = { ...fields };
  if (hasValue6(extracted.full_name) && isPlausibleCallerName(extracted.full_name) && !hasValue6(updated.full_name)) {
    updated.full_name = extracted.full_name.trim().slice(0, 100);
  }
  if (hasValue6(extracted.problem_description) && !hasValue6(updated.problem_description)) {
    updated.problem_description = extracted.problem_description.trim().slice(0, 500);
  }
  if (hasValue6(extracted.address) && isPlausibleServiceAddress(extracted.address) && !hasValue6(updated.address)) {
    updated.address = extracted.address.trim().slice(0, 500);
    updated.address_confirmed = false;
  }
  if (hasValue6(extracted.callback_phone)) {
    const normalized = normalizeCallbackPhoneE164(extracted.callback_phone);
    if (!isCompanyPhoneNumber(normalized)) {
      const sameNumber = updated.callback_phone === normalized;
      if (!sameNumber) {
        updated.callback_phone = normalized;
        updated.callback_phone_confirmed = false;
      }
    }
  }
  if (extracted.insurance_claim_started !== void 0 && extracted.insurance_claim_started !== null) {
    updated.insurance_claim_started = extracted.insurance_claim_started;
  }
  if (extracted.adjuster_contacted !== void 0 && extracted.adjuster_contacted !== null) {
    updated.adjuster_contacted = extracted.adjuster_contacted;
  }
  if (extracted.emergency_or_active_leak !== void 0 && extracted.emergency_or_active_leak !== null) {
    updated.emergency_or_active_leak = extracted.emergency_or_active_leak;
  }
  if (extracted.emergency_acknowledged) {
    updated.emergency_acknowledged = true;
  }
  return preserveConfirmedFieldState(fields, syncLegacyStringFields(updated));
}
function applyAnswerForPendingQuestion(fields, answer, callerPhone, pendingQuestion) {
  const trimmed = answer.trim();
  if (!trimmed || !pendingQuestion) {
    return fields;
  }
  let updated = { ...fields };
  switch (pendingQuestion) {
    case "caller_name": {
      if (isCallerNameDeclinedSpeech(trimmed)) {
        updated.caller_name_declined = true;
        updated.full_name = void 0;
        updated.name_needs_clarification = false;
        break;
      }
      if (isCallerNameUnavailableSpeech(trimmed)) {
        updated.caller_name_unavailable = true;
        updated.full_name = void 0;
        updated.name_needs_clarification = false;
        break;
      }
      if (!isCallerNameResolved(updated)) {
        const validated = validateCallerNameCandidate(trimmed, { isDirectNameAnswer: true });
        if (validated.value) {
          updated.full_name = validated.value.slice(0, 100);
          updated.name_needs_clarification = false;
          updated.caller_name_declined = false;
          updated.caller_name_unavailable = false;
        } else if (validated.needsClarification) {
          updated.name_needs_clarification = true;
          updated.name_clarification_attempts = (updated.name_clarification_attempts ?? 0) + 1;
        }
      }
      break;
    }
    case "reason_for_call":
    case "call_reason":
      if (!hasValue6(updated.problem_description)) {
        if (isShortYesNoReasonAnswer(trimmed)) {
          updated.call_reason_awaiting_clarification = true;
          updated.call_reason_clarification_attempts = (updated.call_reason_clarification_attempts ?? 0) + 1;
          break;
        }
        const reason = normalizeCallReasonFromSpeech(trimmed);
        if (reason) {
          updated.problem_description = reason;
          updated.call_reason_awaiting_clarification = false;
          updated.name_pending_confirmation = void 0;
          updated.name_awaiting_repeat = void 0;
          const volunteeredName = extractExplicitCallerName(trimmed);
          if (volunteeredName && !hasValue6(updated.full_name)) {
            updated.full_name = volunteeredName;
          }
        } else if (trimmed.length > 0) {
          updated.call_reason_awaiting_clarification = true;
          updated.call_reason_clarification_attempts = (updated.call_reason_clarification_attempts ?? 0) + 1;
        }
      }
      break;
    case "callback_confirmation": {
      if (isCallbackConfirmed(trimmed)) {
        updated.callback_phone_confirmed = true;
      } else if (isCallbackRejected(trimmed)) {
        break;
      } else {
        const phone = extractCallbackPhoneFromSpeech(trimmed, callerPhone, {
          allowAffirmativeReuse: true
        });
        if (phone && !isCompanyPhoneNumber(phone)) {
          updated.callback_phone = phone;
          updated.callback_phone_confirmed = false;
        }
      }
      break;
    }
    case "address_confirmation": {
      if (isAddressConfirmedSpeech(trimmed)) {
        updated = confirmAddress(updated);
      } else if (isAddressRejectedSpeech(trimmed)) {
        break;
      }
      break;
    }
    case "callback_phone":
      if (/^(yes|yeah|yep|correct|this one|that one|same number)\b/i.test(trimmed) && callerPhone) {
        updated.callback_phone = normalizeCallbackPhoneE164(callerPhone);
        updated.callback_phone_confirmed = false;
      } else {
        const phone = extractCallbackPhoneFromSpeech(trimmed, callerPhone, {
          allowAffirmativeReuse: true
        });
        if (phone && !isCompanyPhoneNumber(phone)) {
          updated.callback_phone = phone;
          updated.callback_phone_confirmed = false;
        }
      }
      break;
    case "service_address":
      if (!hasValue6(updated.address)) {
        if (isPlausibleServiceAddress(trimmed)) {
          updated.address = trimmed.slice(0, 500);
          updated.address_confirmed = false;
        }
      }
      break;
    case "insurance_claim":
    case "adjuster_contacted":
    case "active_leak": {
      const parsed = parseExplicitBoolean(trimmed);
      if (parsed !== null) {
        const fieldMap = {
          insurance_claim: "insurance_claim_started",
          adjuster_contacted: "adjuster_contacted",
          active_leak: "emergency_or_active_leak"
        };
        updated[fieldMap[pendingQuestion]] = parsed;
      }
      break;
    }
    case "urgency":
      if (!hasValue6(updated.urgency)) {
        updated.urgency = trimmed.slice(0, 200);
      }
      break;
    case "preferred_callback_time":
      updated.appointment_preference_raw = trimmed.slice(0, 200);
      updated.schedule_confirmed = false;
      updated.schedule_pending_clarification = false;
      break;
    default:
      break;
  }
  return preserveConfirmedFieldState(fields, syncLegacyStringFields(updated));
}

// src/orchestrator/realtime-intake.ts
function hasValue7(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function mergeRealtimeCallerAnswer(fields, answer, callerPhone, options = {}) {
  const conversationState = options.conversationState ?? "collecting_intake";
  if (conversationState === "listening_for_reason") {
    return sanitizeInvalidStoredCallerName(fields);
  }
  const sanitizedFields = sanitizeInvalidStoredCallerName(fields);
  const pendingQuestion = resolveActivePendingQuestion(
    sanitizedFields,
    conversationState,
    options.pendingQuestion
  );
  const fieldsBeforeMerge = sanitizedFields;
  let updated = applyAnswerForPendingQuestion(sanitizedFields, answer, callerPhone, pendingQuestion);
  updated = {
    ...updated,
    pending_question: void 0
  };
  const shortAnswer = isShortPendingStyleAnswer(answer);
  const afterPendingOnly = updated;
  if (!shortAnswer) {
    const extracted = extractAllFieldsFromTranscript(answer, callerPhone, pendingQuestion);
    updated = mergeExtractedFields(updated, extracted);
    const missingBeforeDirect = getMissingRequiredFields(updated);
    const openingReasonTurn = isOpeningReasonCaptureContext(updated, {
      isFirstCallerTurn: options.isFirstCallerTurn
    });
    const skipDirectNameFromReasonSpeech = openingReasonTurn && isLikelyCallReasonSpeech(answer) && !extractExplicitCallerName(answer);
    if (missingBeforeDirect.length > 0 && pendingQuestion === null && !skipDirectNameFromReasonSpeech) {
      updated = applyDirectAnswerToMissingField(updated, answer, callerPhone, null);
    }
  }
  if (hasValue7(updated.appointment_preference_raw) && updated.schedule_confirmed !== true) {
    updated = processScheduleCapture(updated, answer).fields;
  }
  const merged = preserveConfirmedFieldState(fields, updated);
  if (isTurnDiagnosticsEnabled()) {
    logAnswerHandler({
      handler: pendingQuestion ? `applyAnswerForPendingQuestion:${pendingQuestion}` : shortAnswer ? "short_answer_without_pending" : "mergeExtractedFields",
      pendingQuestion,
      shortAnswer,
      fieldUpdates: diffTrackedFields(fieldsBeforeMerge, afterPendingOnly),
      rejectedUpdates: diffTrackedFields(afterPendingOnly, merged).filter(
        (update) => update.field === "callback_phone_confirmed" && update.before === true && update.after !== true
      )
    });
  }
  return merged;
}
function applyCallbackCorrection(fields, speech, callerPhone) {
  const phone = extractCallbackPhoneFromSpeech(speech, callerPhone);
  if (!phone || isCompanyPhoneNumber(phone)) {
    return fields;
  }
  return syncLegacyStringFields({
    ...fields,
    callback_phone: normalizeCallbackPhoneE164(phone),
    callback_phone_confirmed: false
  });
}
function confirmCallbackPhone(fields) {
  return syncLegacyStringFields({
    ...fields,
    callback_phone_confirmed: true
  });
}
function buildRealtimeAcknowledgment(policy, answer, fields, filledCount, nextField, afterConfirmation = false) {
  return policy.selectAcknowledgment({
    nextField,
    answer,
    isEmergency: detectEmergency(answer),
    emergencyAlreadyAcknowledged: fields.emergency_acknowledged === true,
    filledCount,
    afterConfirmation
  });
}
function buildIntakeReply(policy, fields, answer, callerPhone, filledCount, afterConfirmation = false) {
  const nextField = getNextRequiredField(fields);
  if (!nextField) {
    return REALTIME_ANYTHING_ELSE_QUESTION;
  }
  const question = getNaturalTransitionQuestion(nextField, fields, callerPhone);
  const ack = buildRealtimeAcknowledgment(
    policy,
    answer,
    fields,
    filledCount,
    nextField,
    afterConfirmation
  );
  const fallback = getRequiredFieldQuestion(nextField, fields, callerPhone);
  const combined = joinAcknowledgmentAndQuestion(ack, question);
  return guardIntakeReply(combined, fallback);
}
function appendAnythingElseNotes(fields, speech) {
  const trimmed = speech.trim();
  if (!trimmed || isAnythingElseDeclined2(trimmed)) {
    return fields;
  }
  const existing = fields.additional_notes?.trim();
  const combined = existing ? `${existing} ${trimmed}` : trimmed;
  return syncLegacyStringFields({
    ...fields,
    additional_notes: combined.slice(0, 500)
  });
}
function isAnythingElseDeclined2(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(no|nope|nah|nothing|none|that's all|thats all|that is all|i'm good|im good|all set|nothing else)\b/.test(
    normalized
  ) || normalized.includes("nothing else");
}
function countNewlyFilledFields(before, after) {
  const beforeMissing = new Set(getMissingRequiredFields(before));
  const afterMissing = new Set(getMissingRequiredFields(after));
  let count = 0;
  for (const field of beforeMissing) {
    if (!afterMissing.has(field)) {
      count += 1;
    }
  }
  return count;
}
function normalizeRealtimeFields(fields) {
  return sanitizeInvalidStoredCallerName({
    ...fields,
    insurance_claim_started: fields.insurance_claim_started ?? normalizeTriStateField(fields.insurance_claim),
    adjuster_contacted: normalizeTriStateField(fields.adjuster_contacted),
    photos_available: normalizePhotosValue(fields.photos_available),
    emergency_or_active_leak: fields.emergency_or_active_leak ?? normalizeTriStateField(fields.active_leak)
  });
}
function toPersistedFields(fields) {
  return toCollectedFields(normalizeRealtimeFields(fields));
}

// src/orchestrator/realtime-turn-processor.ts
function applyLocalSessionUpdate(session, input) {
  return {
    ...session,
    collected_fields: input.collectedFields ? toPersistedFields(input.collectedFields) : session.collected_fields,
    current_question: input.currentQuestion ?? session.current_question
  };
}
async function persistTurn(callSid, input) {
  const session = await updateCallSession({
    callSid,
    collectedFields: input.collectedFields ? toPersistedFields(input.collectedFields) : void 0,
    currentQuestion: input.currentQuestion ?? null,
    transcriptEntry: createTranscriptEntry("caller", input.callerSpeech)
  }) ?? null;
  await updateCallSession({
    callSid,
    transcriptEntry: createTranscriptEntry("assistant", input.assistantReply)
  });
  return session;
}
function persistTurnAsync(callSid, input) {
  void persistTurn(callSid, input).catch((error) => {
    logError("persist_turn_failed", { callSid }, error);
  });
}
function finishTurn(input, outcome) {
  return {
    ...outcome,
    replyText: outcome.replyText.trim(),
    structuredStateUpdated: true
  };
}
var SAFE_INTAKE_REPROMPT = "Thanks for your patience. Could you tell me what the roofing team can help you with?";
var SAFE_ERROR_REPROMPT = "Thanks for your patience. Could you repeat that last answer for me?";
function ensureNonEmptyReply(replyText, fallback) {
  const trimmed = replyText.trim();
  return trimmed || fallback;
}
function clearErroneousNameCaptureForReason(fields) {
  const cleaned = sanitizeInvalidStoredCallerName({ ...fields });
  if (cleaned.problem_description?.trim()) {
    return cleaned;
  }
  if (cleaned.full_name && !isPlausibleCallerName(cleaned.full_name)) {
    cleaned.full_name = void 0;
  }
  const pendingName = cleaned.name_pending_confirmation?.trim();
  if (pendingName && !isPlausibleCallerName(pendingName)) {
    cleaned.name_pending_confirmation = void 0;
    cleaned.name_awaiting_repeat = void 0;
  }
  return cleaned;
}
function shouldHandlePendingCallReason(fields, conversationState) {
  const pending = resolvePendingQuestion(fields, conversationState);
  return isListeningForCallReason(conversationState, pending) && !fields.problem_description?.trim();
}
function buildInvalidNameCaptureRepeatOutcome(input) {
  const attempts = (input.fields.name_clarification_attempts ?? 0) + 1;
  return {
    status: "repeat",
    fields: {
      ...input.fields,
      name_pending_confirmation: void 0,
      name_awaiting_repeat: true,
      name_needs_clarification: true,
      name_clarification_attempts: attempts
    },
    replyText: buildNameClarificationPrompt(void 0, { askToSpell: attempts >= 2 }),
    nameConfirmationRequested: false,
    nameCorrected: false
  };
}
function processValidatedNameCaptureTurn(input) {
  const outcome = processNameCaptureTurn({
    fields: input.fields,
    speech: input.speech,
    confidence: null
  });
  if (outcome.status === "confirm") {
    const pendingName = outcome.fields.name_pending_confirmation?.trim();
    if (pendingName && !isPlausibleCallerName(pendingName)) {
      return buildInvalidNameCaptureRepeatOutcome(input);
    }
    return outcome;
  }
  if (outcome.status !== "accepted") {
    return outcome;
  }
  const acceptedName = outcome.fields.full_name?.trim();
  if (acceptedName && isPlausibleCallerName(acceptedName)) {
    return outcome;
  }
  return buildInvalidNameCaptureRepeatOutcome(input);
}
function buildCallbackConfirmationReply(fields) {
  return ensureSingleIntakeQuestion(
    buildCallbackReadbackConfirmation(fields.callback_phone ?? "")
  );
}
function buildAddressConfirmationReply(fields) {
  return ensureSingleIntakeQuestion(
    buildAddressReadbackConfirmation(fields.address ?? "")
  );
}
function buildScheduleConfirmationReply(fields) {
  const spoken = fields.appointment_preference?.trim();
  if (spoken?.startsWith("Would ")) {
    return ensureSingleIntakeQuestion(spoken);
  }
  const label = spoken || fields.appointment_preference_raw?.trim() || "the requested time";
  return ensureSingleIntakeQuestion(buildScheduleConfirmationQuestion(label));
}
function finalizeIntakeFields(fields, nextState) {
  const statePending = pendingQuestionForConversationState(nextState);
  if (statePending) {
    return attachPendingQuestion(fields, statePending);
  }
  return attachPendingQuestion(fields, pendingQuestionForNextField(getNextRequiredField(fields)));
}
function packagePostIntakeResult(fields, replyText, nextState, options = {}) {
  const finalized = finalizeIntakeFields(fields, nextState);
  if (isTurnDiagnosticsEnabled()) {
    const branch = explainPostIntakeBranch(fields, options);
    logNextActionSelection({
      nextAction: branch.action,
      reason: branch.reason,
      nextConversationState: nextState,
      pendingQuestionAfter: finalized.pending_question?.trim() ?? null,
      replyPreview: replyText
    });
  }
  return {
    replyText,
    fields: finalized,
    nextState
  };
}
function buildPostIntakeReply(policy, fieldsBefore, updatedFields, trimmedSpeech, callerPhone, filledCount, options = {}) {
  const nextRequired = getNextRequiredField(updatedFields);
  if (options.isFirstCallerTurn === true && canAdvanceAfterOpening(updatedFields, {
    hasReceivedMeaningfulCallerTranscript: options.hasReceivedMeaningfulCallerTranscript
  }) && updatedFields.intake_intro_delivered !== true && updatedFields.problem_description?.trim() && (nextRequired === "full_name" || nextRequired === "emergency_or_active_leak")) {
    const question = nextRequired === "full_name" ? EARLY_CALLER_NAME_QUESTION : getNaturalTransitionQuestion(nextRequired, updatedFields, callerPhone);
    return packagePostIntakeResult(
      {
        ...updatedFields,
        intake_intro_delivered: true
      },
      ensureSingleIntakeQuestion(
        `${REALTIME_INTRO_TRANSITION} ${question}`.replace(/\s+/g, " ").trim()
      ),
      "collecting_intake",
      options
    );
  }
  if (isCallerNameResolved(updatedFields) && !needsImmediateSafetyClarification(updatedFields) && needsCallbackReadback(updatedFields) && nextRequired === "callback_phone") {
    return packagePostIntakeResult(
      updatedFields,
      buildCallbackConfirmationReply(updatedFields),
      "awaiting_callback_confirmation",
      options
    );
  }
  if (isCallerNameResolved(updatedFields) && isCallbackPhoneResolved(updatedFields) && needsAddressReadback(updatedFields) && nextRequired === "address") {
    return packagePostIntakeResult(
      updatedFields,
      buildAddressConfirmationReply(updatedFields),
      "awaiting_address_confirmation",
      options
    );
  }
  if (needsScheduleClarification(updatedFields)) {
    const prompt = updatedFields.schedule_clarification_prompt?.trim() || "What time works best?";
    return packagePostIntakeResult(
      updatedFields,
      ensureSingleIntakeQuestion(prompt),
      "awaiting_schedule_clarification",
      options
    );
  }
  if (needsScheduleConfirmation(updatedFields)) {
    return packagePostIntakeResult(
      updatedFields,
      buildScheduleConfirmationReply(updatedFields),
      "awaiting_schedule_confirmation",
      options
    );
  }
  const missing = getMissingRequiredFields(updatedFields);
  const sharedMissing = getSharedMissingFields(updatedFields).filter(
    (field) => field !== "additionalNotes"
  );
  if (missing.length === 0 && sharedMissing.length === 0) {
    const anythingElseQuestion = REALTIME_ANYTHING_ELSE_QUESTION;
    const reply = ensureSingleIntakeQuestion(anythingElseQuestion);
    return packagePostIntakeResult(updatedFields, reply, "awaiting_additional_notes", options);
  }
  const intakeReply = buildIntakeReply(
    policy,
    updatedFields,
    trimmedSpeech,
    callerPhone,
    filledCount,
    options.afterConfirmation === true
  );
  const combinedReply = ensureSingleIntakeQuestion(intakeReply);
  return packagePostIntakeResult(updatedFields, combinedReply, "collecting_intake", options);
}
function isNameCaptureTurn(fields, conversationState, speech, options = {}) {
  if (conversationState === "listening_for_reason") {
    return false;
  }
  if (blocksGenericReadbackConfirmation(fields, conversationState)) {
    return false;
  }
  const pending = resolvePendingQuestion(fields, conversationState);
  if (isPendingCallReasonQuestion(pending) || !fields.problem_description?.trim()) {
    return false;
  }
  if (isAwaitingNameConfirmation(fields) || fields.name_awaiting_repeat === true) {
    return true;
  }
  if (conversationState !== "collecting_intake") {
    return false;
  }
  if (getNextRequiredField(fields) !== "full_name") {
    return false;
  }
  if (isOpeningReasonCaptureContext(fields, options)) {
    return false;
  }
  if (isLikelyCallReasonSpeech(speech)) {
    return false;
  }
  return true;
}
async function processRealtimeCallerTurn(input) {
  const { callSid, callerPhone, speechResult, conversationState, acknowledgmentPolicy } = input;
  let session = input.session;
  const trimmedSpeech = speechResult.trim();
  if (conversationState === "closing_audio_playback" || conversationState === "completed") {
    return {
      replyText: "",
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: conversationState
    };
  }
  if (isExplicitCallerHangupDuringIntake(trimmedSpeech) && conversationState === "collecting_intake") {
    if (callSid) {
      void completeCallSession(callSid, "completed").catch((error) => {
        logError("complete_call_session_failed", { callSid }, error);
      });
    }
    return finishTurn(input, {
      replyText: "Thanks for calling Beau's Roofing \u2014 have a great day.",
      hangup: true,
      hangupAfterMark: true,
      session,
      nextConversationState: "completed"
    });
  }
  if (!session || !callSid) {
    return finishTurn(input, {
      replyText: ensureSingleIntakeQuestion("What's going on with the roof?"),
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "collecting_intake"
    });
  }
  const fieldsBefore = clearErroneousNameCaptureForReason(
    normalizeRealtimeFields(session.collected_fields ?? {})
  );
  if (isTurnDiagnosticsEnabled()) {
    logTurnStart({
      callId: callSid,
      turnId: input.turnId ?? 0,
      transcript: trimmedSpeech,
      conversationState,
      fieldsBefore
    });
  }
  if (conversationState === "awaiting_callback_confirmation") {
    if (!trimmedSpeech) {
      return {
        replyText: "",
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_callback_confirmation"
      };
    }
    if (isCallbackConfirmed(trimmedSpeech)) {
      const confirmedFields = confirmCallbackPhone(fieldsBefore);
      const filledCount2 = countNewlyFilledFields(fieldsBefore, confirmedFields);
      const post2 = buildPostIntakeReply(
        acknowledgmentPolicy,
        fieldsBefore,
        confirmedFields,
        trimmedSpeech,
        callerPhone,
        filledCount2,
        { afterConfirmation: true }
      );
      session = applyLocalSessionUpdate(session, {
        collectedFields: post2.fields,
        currentQuestion: post2.replyText
      });
      persistTurnAsync(callSid, {
        collectedFields: post2.fields,
        currentQuestion: post2.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: post2.replyText
      });
      return finishTurn(input, {
        replyText: post2.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: post2.nextState
      });
    }
    if (isCallbackRejected(trimmedSpeech) || trimmedSpeech.length > 0) {
      const correctedFields = applyCallbackCorrection(fieldsBefore, trimmedSpeech, callerPhone);
      const reply = buildCallbackConfirmationReply(correctedFields);
      session = applyLocalSessionUpdate(session, {
        collectedFields: correctedFields,
        currentQuestion: reply
      });
      persistTurnAsync(callSid, {
        collectedFields: correctedFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply
      });
      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_callback_confirmation"
      });
    }
  }
  if (conversationState === "awaiting_address_confirmation") {
    if (!trimmedSpeech) {
      return {
        replyText: "",
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_address_confirmation"
      };
    }
    if (isAddressConfirmedSpeech(trimmedSpeech)) {
      const confirmedFields = confirmAddress(fieldsBefore);
      const filledCount2 = countNewlyFilledFields(fieldsBefore, confirmedFields);
      const post2 = buildPostIntakeReply(
        acknowledgmentPolicy,
        fieldsBefore,
        confirmedFields,
        trimmedSpeech,
        callerPhone,
        filledCount2,
        { afterConfirmation: true }
      );
      session = applyLocalSessionUpdate(session, {
        collectedFields: post2.fields,
        currentQuestion: post2.replyText
      });
      persistTurnAsync(callSid, {
        collectedFields: post2.fields,
        currentQuestion: post2.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: post2.replyText
      });
      return finishTurn(input, {
        replyText: post2.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: post2.nextState
      });
    }
    if (isAddressRejectedSpeech(trimmedSpeech) || trimmedSpeech.length > 0) {
      const correctedFields = applyAddressCorrection(fieldsBefore, trimmedSpeech);
      const reply = buildAddressConfirmationReply(correctedFields);
      session = applyLocalSessionUpdate(session, {
        collectedFields: correctedFields,
        currentQuestion: reply
      });
      persistTurnAsync(callSid, {
        collectedFields: correctedFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply
      });
      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_address_confirmation"
      });
    }
  }
  if (conversationState === "awaiting_schedule_clarification") {
    if (!trimmedSpeech) {
      return finishTurn(input, {
        replyText: SCHEDULE_PARSE_FALLBACK_PROMPT,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_clarification"
      });
    }
    const capture = processScheduleCapture(fieldsBefore, trimmedSpeech);
    let nextFields = capture.fields;
    if (capture.clarificationPrompt) {
      const reply = ensureSingleIntakeQuestion(capture.clarificationPrompt);
      session = applyLocalSessionUpdate(session, {
        collectedFields: nextFields,
        currentQuestion: reply
      });
      persistTurnAsync(callSid, {
        collectedFields: nextFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply
      });
      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_clarification"
      });
    }
    if (capture.confirmationPrompt) {
      const reply = ensureSingleIntakeQuestion(capture.confirmationPrompt);
      session = applyLocalSessionUpdate(session, {
        collectedFields: nextFields,
        currentQuestion: reply
      });
      persistTurnAsync(callSid, {
        collectedFields: nextFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply
      });
      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_confirmation"
      });
    }
    const filledCount2 = countNewlyFilledFields(fieldsBefore, nextFields);
    const post2 = buildPostIntakeReply(
      acknowledgmentPolicy,
      fieldsBefore,
      nextFields,
      trimmedSpeech,
      callerPhone,
      filledCount2
    );
    session = applyLocalSessionUpdate(session, {
      collectedFields: post2.fields,
      currentQuestion: post2.replyText
    });
    persistTurnAsync(callSid, {
      collectedFields: post2.fields,
      currentQuestion: post2.replyText,
      callerSpeech: trimmedSpeech,
      assistantReply: post2.replyText
    });
    return finishTurn(input, {
      replyText: ensureNonEmptyReply(
        post2.replyText,
        SCHEDULE_PARSE_FALLBACK_PROMPT
      ),
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: post2.nextState
    });
  }
  if (conversationState === "awaiting_schedule_confirmation") {
    if (!trimmedSpeech) {
      return finishTurn(input, {
        replyText: buildScheduleConfirmationReply(fieldsBefore),
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_schedule_confirmation"
      });
    }
    if (isScheduleConfirmedSpeech(trimmedSpeech)) {
      const confirmedFields = confirmSchedule(fieldsBefore);
      const filledCount2 = countNewlyFilledFields(fieldsBefore, confirmedFields);
      const post2 = buildPostIntakeReply(
        acknowledgmentPolicy,
        fieldsBefore,
        confirmedFields,
        trimmedSpeech,
        callerPhone,
        filledCount2,
        { afterConfirmation: true }
      );
      session = applyLocalSessionUpdate(session, {
        collectedFields: post2.fields,
        currentQuestion: post2.replyText
      });
      persistTurnAsync(callSid, {
        collectedFields: post2.fields,
        currentQuestion: post2.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: post2.replyText
      });
      return finishTurn(input, {
        replyText: post2.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: post2.nextState
      });
    }
    if (isScheduleRejectedSpeech(trimmedSpeech) || trimmedSpeech.length > 0) {
      const resetFields = {
        ...fieldsBefore,
        appointment_preference_raw: trimmedSpeech,
        appointment_preference: void 0,
        appointment_schedule_iso: void 0,
        appointment_schedule_iso_end: void 0,
        schedule_confirmed: false,
        schedule_pending_clarification: false
      };
      const capture = processScheduleCapture(resetFields, trimmedSpeech);
      const nextFields = capture.fields;
      if (capture.clarificationPrompt) {
        const reply2 = ensureSingleIntakeQuestion(capture.clarificationPrompt);
        session = applyLocalSessionUpdate(session, {
          collectedFields: nextFields,
          currentQuestion: reply2
        });
        persistTurnAsync(callSid, {
          collectedFields: nextFields,
          currentQuestion: reply2,
          callerSpeech: trimmedSpeech,
          assistantReply: reply2
        });
        return finishTurn(input, {
          replyText: reply2,
          hangup: false,
          hangupAfterMark: false,
          session,
          nextConversationState: "awaiting_schedule_clarification"
        });
      }
      const reply = capture.confirmationPrompt ? ensureSingleIntakeQuestion(capture.confirmationPrompt) : ensureNonEmptyReply(
        buildScheduleConfirmationReply(nextFields),
        SCHEDULE_PARSE_FALLBACK_PROMPT
      );
      session = applyLocalSessionUpdate(session, {
        collectedFields: nextFields,
        currentQuestion: reply
      });
      persistTurnAsync(callSid, {
        collectedFields: nextFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply
      });
      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: capture.confirmationPrompt ? "awaiting_schedule_confirmation" : "awaiting_schedule_confirmation"
      });
    }
  }
  if (conversationState === "awaiting_additional_notes") {
    const sharedMissing = getSharedMissingFields(fieldsBefore).filter(
      (field) => field !== "additionalNotes"
    );
    if (getMissingRequiredFields(fieldsBefore).length > 0 || sharedMissing.length > 0) {
      const reply2 = ensureSingleIntakeQuestion(
        buildIntakeReply(acknowledgmentPolicy, fieldsBefore, trimmedSpeech, callerPhone, 0)
      );
      return finishTurn(input, {
        replyText: reply2,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake"
      });
    }
    let updatedFields2 = syncLegacyStringFields({
      ...fieldsBefore,
      additional_notes_responded: true
    });
    if (!isAnythingElseDeclined(trimmedSpeech)) {
      updatedFields2 = appendAnythingElseNotes(updatedFields2, trimmedSpeech);
    }
    if (!isSharedIntakeComplete(updatedFields2) || !canPresentSummary(updatedFields2)) {
      const reply2 = ensureSingleIntakeQuestion(
        buildIntakeReply(acknowledgmentPolicy, updatedFields2, trimmedSpeech, callerPhone, 0)
      );
      return finishTurn(input, {
        replyText: reply2,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake"
      });
    }
    const reply = ensureSingleIntakeQuestion(buildSummaryWithConfirmation(updatedFields2));
    session = applyLocalSessionUpdate(session, {
      collectedFields: updatedFields2,
      currentQuestion: reply
    });
    persistTurnAsync(callSid, {
      collectedFields: updatedFields2,
      currentQuestion: reply,
      callerSpeech: trimmedSpeech,
      assistantReply: reply
    });
    return finishTurn(input, {
      replyText: reply,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "presenting_summary"
    });
  }
  if (conversationState === "awaiting_summary_confirmation" || conversationState === "handling_correction") {
    if (!trimmedSpeech) {
      return {
        replyText: "",
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: canPresentSummary(fieldsBefore) ? "awaiting_summary_confirmation" : "collecting_intake"
      };
    }
    if (!canPresentSummary(fieldsBefore)) {
      const reply = ensureSingleIntakeQuestion(
        buildIntakeReply(acknowledgmentPolicy, fieldsBefore, trimmedSpeech, callerPhone, 0)
      );
      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake"
      });
    }
    if (isSummaryConfirmed(trimmedSpeech) && canCloseCall(fieldsBefore, conversationState, trimmedSpeech)) {
      const confirmedFields = syncLegacyStringFields({
        ...fieldsBefore,
        summary_confirmed: true
      });
      const reply = buildClosingMessage();
      session = applyLocalSessionUpdate(session, {
        collectedFields: confirmedFields,
        currentQuestion: null
      });
      void completeCallSession(callSid, "completed").catch((error) => {
        logError("complete_call_session_failed", { callSid }, error);
      });
      persistTurnAsync(callSid, {
        collectedFields: confirmedFields,
        currentQuestion: null,
        callerSpeech: trimmedSpeech,
        assistantReply: reply
      });
      return finishTurn(input, {
        replyText: ensureSingleIntakeQuestion(reply),
        hangup: true,
        hangupAfterMark: true,
        session,
        nextConversationState: "delivering_closing"
      });
    }
    if (isSummaryRejected(trimmedSpeech) || trimmedSpeech.length > 0) {
      const correctedFields = applyCorrectionToStructuredField(fieldsBefore, trimmedSpeech);
      const reply = ensureSingleIntakeQuestion(
        `${buildStructuredSpokenSummary(correctedFields)} Does that sound correct now?`
      );
      session = applyLocalSessionUpdate(session, {
        collectedFields: correctedFields,
        currentQuestion: reply
      });
      persistTurnAsync(callSid, {
        collectedFields: correctedFields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply
      });
      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "awaiting_summary_confirmation"
      });
    }
    return {
      replyText: "",
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "awaiting_summary_confirmation"
    };
  }
  if (shouldHandlePendingCallReason(fieldsBefore, conversationState)) {
    const capture = applyCallReasonCapture(fieldsBefore, trimmedSpeech);
    if (!capture.resolved) {
      const reply = ensureSingleIntakeQuestion(
        resolveCallReasonClarificationReply(capture.fields, trimmedSpeech)
      );
      session = applyLocalSessionUpdate(session, {
        collectedFields: capture.fields,
        currentQuestion: reply
      });
      persistTurnAsync(callSid, {
        collectedFields: capture.fields,
        currentQuestion: reply,
        callerSpeech: trimmedSpeech,
        assistantReply: reply
      });
      return finishTurn(input, {
        replyText: reply,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "listening_for_reason"
      });
    }
    let updatedFields2 = syncLegacyStringFields({
      ...capture.fields,
      call_reason_awaiting_clarification: false
    });
    if (detectEmergency(trimmedSpeech) && !updatedFields2.emergency_acknowledged) {
      updatedFields2 = {
        ...updatedFields2,
        urgency: updatedFields2.urgency ?? "emergency",
        emergency_acknowledged: true
      };
    }
    const post2 = buildCallReasonResolvedReply(updatedFields2, callerPhone);
    session = applyLocalSessionUpdate(session, {
      collectedFields: post2.fields,
      currentQuestion: post2.replyText
    });
    persistTurnAsync(callSid, {
      collectedFields: post2.fields,
      currentQuestion: post2.replyText,
      callerSpeech: trimmedSpeech,
      assistantReply: post2.replyText
    });
    return finishTurn(input, {
      replyText: ensureNonEmptyReply(
        post2.replyText,
        SAFE_INTAKE_REPROMPT
      ),
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: post2.nextState
    });
  }
  if (conversationState === "listening_for_reason" && !fieldsBefore.problem_description?.trim()) {
    return {
      replyText: "",
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "listening_for_reason"
    };
  }
  if (isNameCaptureTurn(fieldsBefore, conversationState, trimmedSpeech, {
    isFirstCallerTurn: input.isFirstCallerTurn
  })) {
    const nameOutcome = processValidatedNameCaptureTurn({
      fields: fieldsBefore,
      speech: trimmedSpeech
    });
    if (nameOutcome.status === "confirm" || nameOutcome.status === "repeat") {
      session = applyLocalSessionUpdate(session, {
        collectedFields: nameOutcome.fields,
        currentQuestion: nameOutcome.replyText
      });
      persistTurnAsync(callSid, {
        collectedFields: nameOutcome.fields,
        currentQuestion: nameOutcome.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: nameOutcome.replyText
      });
      return finishTurn(input, {
        replyText: ensureSingleIntakeQuestion(nameOutcome.replyText),
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: "collecting_intake"
      });
    }
    const confirmedFields = nameOutcome.fields;
    const filledCount2 = countNewlyFilledFields(fieldsBefore, confirmedFields);
    const post2 = buildPostIntakeReply(
      acknowledgmentPolicy,
      fieldsBefore,
      confirmedFields,
      trimmedSpeech,
      callerPhone,
      filledCount2
    );
    session = applyLocalSessionUpdate(session, {
      collectedFields: post2.fields,
      currentQuestion: post2.replyText
    });
    persistTurnAsync(callSid, {
      collectedFields: post2.fields,
      currentQuestion: post2.replyText,
      callerSpeech: trimmedSpeech,
      assistantReply: post2.replyText
    });
    return finishTurn(input, {
      replyText: post2.replyText,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: post2.nextState
    });
  }
  let updatedFields = mergeRealtimeCallerAnswer(fieldsBefore, trimmedSpeech, callerPhone, {
    conversationState,
    isFirstCallerTurn: input.isFirstCallerTurn
  });
  if (isTurnDiagnosticsEnabled()) {
    logTurnStateAfterMerge({
      fieldsAfter: updatedFields,
      conversationState
    });
  }
  if (detectEmergency(trimmedSpeech) && !updatedFields.emergency_acknowledged) {
    updatedFields = {
      ...updatedFields,
      urgency: updatedFields.urgency ?? "emergency",
      emergency_acknowledged: true
    };
  }
  if (updatedFields.name_needs_clarification && resolvePendingQuestion(updatedFields, conversationState) === "caller_name") {
    const attempts = updatedFields.name_clarification_attempts ?? 0;
    if (attempts >= 3) {
      updatedFields = syncLegacyStringFields({
        ...updatedFields,
        caller_name_unavailable: true,
        name_needs_clarification: false
      });
      const filledCount2 = countNewlyFilledFields(fieldsBefore, updatedFields);
      const post2 = buildPostIntakeReply(
        acknowledgmentPolicy,
        fieldsBefore,
        updatedFields,
        trimmedSpeech,
        callerPhone,
        filledCount2
      );
      session = applyLocalSessionUpdate(session, {
        collectedFields: post2.fields,
        currentQuestion: post2.replyText
      });
      persistTurnAsync(callSid, {
        collectedFields: post2.fields,
        currentQuestion: post2.replyText,
        callerSpeech: trimmedSpeech,
        assistantReply: post2.replyText
      });
      return finishTurn(input, {
        replyText: post2.replyText,
        hangup: false,
        hangupAfterMark: false,
        session,
        nextConversationState: post2.nextState
      });
    }
    const reply = ensureSingleIntakeQuestion(
      buildNameClarificationPrompt(trimmedSpeech, { askToSpell: attempts >= 2 })
    );
    session = applyLocalSessionUpdate(session, {
      collectedFields: updatedFields,
      currentQuestion: reply
    });
    persistTurnAsync(callSid, {
      collectedFields: updatedFields,
      currentQuestion: reply,
      callerSpeech: trimmedSpeech,
      assistantReply: reply
    });
    return finishTurn(input, {
      replyText: reply,
      hangup: false,
      hangupAfterMark: false,
      session,
      nextConversationState: "collecting_intake"
    });
  }
  const filledCount = countNewlyFilledFields(fieldsBefore, updatedFields);
  const post = buildPostIntakeReply(
    acknowledgmentPolicy,
    fieldsBefore,
    updatedFields,
    trimmedSpeech,
    callerPhone,
    filledCount,
    {
      afterConfirmation: false,
      isFirstCallerTurn: input.isFirstCallerTurn,
      hasReceivedMeaningfulCallerTranscript: input.hasReceivedMeaningfulCallerTranscript
    }
  );
  session = applyLocalSessionUpdate(session, {
    collectedFields: post.fields,
    currentQuestion: post.replyText
  });
  persistTurnAsync(callSid, {
    collectedFields: post.fields,
    currentQuestion: post.replyText,
    callerSpeech: trimmedSpeech,
    assistantReply: post.replyText
  });
  return finishTurn(input, {
    replyText: ensureNonEmptyReply(
      post.replyText,
      SAFE_ERROR_REPROMPT
    ),
    hangup: false,
    hangupAfterMark: false,
    session,
    nextConversationState: post.nextState
  });
}

// src/orchestrator/session-orchestrator.ts
var SessionOrchestrator = class {
  constructor(context) {
    this.context = context;
  }
  session = null;
  processingTurn = false;
  pendingTranscript = null;
  conversationState = "collecting_intake";
  awaitingFirstCallerTurn = false;
  listeningForReason = false;
  hasReceivedMeaningfulCallerTranscript = false;
  openingGreetingPlaybackComplete = false;
  acknowledgmentPolicy = new AcknowledgmentPolicy();
  async initialize() {
    try {
      this.session = await ensureCallSessionForTwilioCall({
        callSid: this.context.callSid,
        callerPhone: this.context.callerPhone,
        calledPhone: this.context.calledPhone
      });
      if (this.session) {
        await updateCallSession({
          callSid: this.context.callSid,
          currentQuestion: REALTIME_OPENING_QUESTION,
          transcriptEntry: createTranscriptEntry("assistant", REALTIME_OPENING_GREETING)
        });
      }
    } catch (error) {
      logError("session_initialize_failed", { callSid: this.context.callSid }, error);
    }
    logInfo("session_initialized", {
      callSid: this.context.callSid,
      hasSession: Boolean(this.session)
    });
    return REALTIME_OPENING_GREETING;
  }
  getOpeningGreeting() {
    return REALTIME_OPENING_GREETING;
  }
  isOpeningGreetingPlaybackComplete() {
    return this.openingGreetingPlaybackComplete;
  }
  getConversationState() {
    return this.conversationState;
  }
  onAssistantResponseDone() {
    if (this.conversationState === "presenting_summary") {
      const fields = this.session?.collected_fields ?? {};
      if (canPresentSummary(fields)) {
        this.conversationState = "awaiting_summary_confirmation";
      } else {
        this.conversationState = "collecting_intake";
        logWarn("summary_state_reverted_incomplete_intake", {
          callSid: this.context.callSid
        });
      }
      logInfo("conversation_state_transition", {
        callSid: this.context.callSid,
        state: this.conversationState
      });
    }
    if (this.conversationState === "delivering_closing") {
      this.conversationState = "closing_audio_playback";
      logInfo("conversation_state_transition", {
        callSid: this.context.callSid,
        state: this.conversationState
      });
    }
  }
  onClosingMarkPlayed() {
    this.conversationState = "completed";
    logInfo("conversation_state_transition", {
      callSid: this.context.callSid,
      state: this.conversationState
    });
  }
  hasPendingTranscript() {
    return Boolean(this.pendingTranscript);
  }
  consumePendingTranscript() {
    const pending = this.pendingTranscript;
    this.pendingTranscript = null;
    return pending;
  }
  markOpeningDelivered() {
    this.awaitingFirstCallerTurn = true;
  }
  onOpeningGreetingComplete() {
    this.openingGreetingPlaybackComplete = true;
    this.listeningForReason = true;
    this.conversationState = "listening_for_reason";
    this.attachPendingCallReason();
    logInfo("conversation_state_transition", {
      callSid: this.context.callSid,
      state: this.conversationState
    });
  }
  isListeningForReason() {
    return this.listeningForReason && !this.hasReceivedMeaningfulCallerTranscript;
  }
  hasMeaningfulCallerTranscript() {
    return this.hasReceivedMeaningfulCallerTranscript;
  }
  onMeaningfulCallerTranscriptProcessed() {
    this.hasReceivedMeaningfulCallerTranscript = true;
    this.listeningForReason = false;
  }
  attachPendingCallReason() {
    if (!this.session) {
      return;
    }
    const fields = this.session.collected_fields ?? {};
    this.session = {
      ...this.session,
      collected_fields: {
        ...fields,
        pending_question: "reason_for_call"
      }
    };
  }
  async handleCallerTranscript(transcript, turnId) {
    const trimmed = transcript.trim();
    if (!trimmed) {
      return null;
    }
    if (this.listeningForReason && !isMeaningfulOpeningCallerTranscript(trimmed)) {
      logInfo("opening_transcript_ignored", {
        callSid: this.context.callSid,
        transcriptLength: trimmed.length
      });
      return null;
    }
    if (this.processingTurn) {
      this.pendingTranscript = trimmed;
      logInfo("caller_transcript_queued", {
        callSid: this.context.callSid,
        queueLength: 1
      });
      return null;
    }
    this.processingTurn = true;
    try {
      if (!this.session) {
        this.session = await getCallSessionBySid(this.context.callSid);
      }
      const outcome = await processRealtimeCallerTurn({
        session: this.session,
        callSid: this.context.callSid,
        callerPhone: this.context.callerPhone,
        speechResult: trimmed,
        conversationState: this.conversationState,
        acknowledgmentPolicy: this.acknowledgmentPolicy,
        isFirstCallerTurn: this.awaitingFirstCallerTurn,
        hasReceivedMeaningfulCallerTranscript: this.hasReceivedMeaningfulCallerTranscript || isMeaningfulOpeningCallerTranscript(trimmed),
        turnId
      });
      if (isMeaningfulOpeningCallerTranscript(trimmed) && outcome.session?.collected_fields?.problem_description) {
        this.onMeaningfulCallerTranscriptProcessed();
      }
      this.session = outcome.session;
      this.conversationState = outcome.nextConversationState;
      this.awaitingFirstCallerTurn = false;
      if (!outcome.replyText) {
        return null;
      }
      return {
        replyText: ensureSingleIntakeQuestion(outcome.replyText),
        hangup: outcome.hangup,
        hangupAfterMark: outcome.hangupAfterMark,
        structuredStateUpdated: outcome.structuredStateUpdated
      };
    } catch (error) {
      logError("turn_processing_failed", { callSid: this.context.callSid }, error);
      return {
        replyText: "Sorry, I missed that \u2014 could you say it again?",
        hangup: false,
        hangupAfterMark: false
      };
    } finally {
      this.processingTurn = false;
    }
  }
  getSession() {
    return this.session;
  }
};

// src/bridge/call-bridge.ts
var CLOSING_MARK_NAME = "closing-final";
var OPENING_GREETING_DEADLINE_MS = 4e3;
var RESPONSE_WATCHDOG_MS = 2e3;
var OPENING_FALLBACK_GREETING = "Thank you for calling Beau's Roofing. One moment while I get ready to help you.";
var CallBridge = class {
  constructor(params) {
    this.params = params;
  }
  streamSid = null;
  callSid = null;
  callerPhone = "";
  calledPhone = "";
  closed = false;
  markCounter = 0;
  callTimeout = null;
  orchestrator = null;
  playbackTracker = new PlaybackTracker();
  callTiming = new CallTimingTracker();
  turnTiming = new TurnTimingTracker();
  responseGuard = new ResponseStateGuard();
  openAi = null;
  bargeIn = null;
  openingGreetingSent = false;
  awaitingClosingMark = false;
  activeResponseUsesClosingMark = false;
  pendingClientResponse = false;
  pendingSpeech = null;
  openingFallbackTimer = null;
  activeTurnId = 0;
  responseWatchdogTimer = null;
  responseWatchdogTurnId = null;
  responseWatchdogRetryUsed = false;
  responseWatchdogRequest = null;
  openingSilence = new OpeningSilenceController();
  openingGreetingPlaybackComplete = false;
  queuedOpeningTranscript = null;
  responseCreateCount = 0;
  openingResponseCreateCount = 0;
  postOpeningResponseCreateCount = 0;
  start() {
    logInfo("twilio_stream_connected");
    this.params.twilioSocket.on("message", (data) => {
      this.handleTwilioMessage(data.toString());
    });
    this.params.twilioSocket.on("close", () => {
      this.cleanup("twilio_socket_closed");
    });
    this.params.twilioSocket.on("error", (error) => {
      logError("twilio_socket_error", {}, error);
      this.cleanup("twilio_socket_error");
    });
  }
  handleTwilioMessage(raw) {
    const event = parseTwilioStreamEvent(raw);
    if (!event) {
      logWarn("twilio_malformed_event");
      return;
    }
    switch (event.event) {
      case "connected":
        logInfo("twilio_stream_protocol_connected", {
          protocol: event.protocol,
          version: event.version
        });
        break;
      case "start":
        void this.handleStreamStart(event.start);
        break;
      case "media":
        this.handleStreamMedia(event.media.payload);
        break;
      case "mark":
        this.handleTwilioMark(event.mark.name);
        break;
      case "stop":
        logInfo("twilio_stream_stopped");
        this.cleanup("twilio_stream_stopped");
        break;
      default:
        logWarn("twilio_unknown_event");
    }
  }
  async handleStreamStart(start) {
    this.streamSid = start.streamSid;
    this.callSid = start.callSid;
    this.callerPhone = start.customParameters?.callerPhone ?? "";
    this.calledPhone = start.customParameters?.calledPhone ?? "";
    const token = start.customParameters?.token;
    const tokenCallSid = start.customParameters?.callSid ?? start.callSid;
    if (!verifyStreamAuthToken(
      tokenCallSid,
      token,
      this.params.config.signingSecret
    )) {
      logError("stream_auth_failed", { callSid: start.callSid });
      this.sendTwilioClose();
      return;
    }
    this.callTiming.record("twilio_stream_started", start.callSid);
    logInfo("twilio_stream_started", {
      callSid: start.callSid,
      streamSid: start.streamSid,
      voice: this.params.config.openAiRealtimeVoice
    });
    this.orchestrator = new SessionOrchestrator({
      callSid: start.callSid,
      callerPhone: this.callerPhone,
      calledPhone: this.calledPhone
    });
    this.openAi = new OpenAiRealtimeSession(
      this.params.config,
      (event) => this.handleOpenAiEvent(event),
      (reason) => this.cleanup(`openai_disconnect:${reason}`)
    );
    this.bargeIn = new BargeInController({
      enabled: this.params.config.bargeInEnabled,
      sendOpenAiEvent: (payload) => this.openAi?.send(payload),
      sendTwilioMessage: (payload) => this.sendTwilioJson(payload),
      getStreamSid: () => this.streamSid,
      getPlayedDurationMs: () => this.playbackTracker.getPlayedDurationMs(),
      getActiveResponseId: () => this.openAi?.getActiveResponseId() ?? null,
      getActiveItemId: () => this.openAi?.getActiveItemId() ?? null,
      onAssistantSpeakingChange: () => {
      }
    });
    this.callTimeout = setTimeout(() => {
      logWarn("call_duration_limit_reached", { callSid: start.callSid });
      this.cleanup("max_call_duration");
    }, this.params.config.maxCallDurationSeconds * 1e3);
    try {
      this.scheduleOpeningFallback();
      const connectPromise = this.openAi.connect().then(() => {
        this.callTiming.record("openai_connected", this.callSid ?? void 0);
      });
      const initPromise = this.orchestrator.initialize();
      const sessionReadyPromise = connectPromise.then(
        () => this.openAi.waitForSessionReady()
      );
      const [openingLine] = await Promise.all([initPromise, sessionReadyPromise]);
      this.clearOpeningFallbackTimer();
      this.sendOpeningGreeting(openingLine);
    } catch (error) {
      logError("stream_start_setup_failed", { callSid: start.callSid }, error);
      this.clearOpeningFallbackTimer();
      this.sendOpeningGreeting(OPENING_FALLBACK_GREETING);
    }
  }
  scheduleOpeningFallback() {
    this.clearOpeningFallbackTimer();
    this.openingFallbackTimer = setTimeout(() => {
      if (!this.openingGreetingSent) {
        logWarn("opening_greeting_fallback", { callSid: this.callSid ?? void 0 });
        this.sendOpeningGreeting(OPENING_FALLBACK_GREETING);
      }
    }, OPENING_GREETING_DEADLINE_MS);
  }
  clearOpeningFallbackTimer() {
    if (this.openingFallbackTimer) {
      clearTimeout(this.openingFallbackTimer);
      this.openingFallbackTimer = null;
    }
  }
  sendOpeningGreeting(openingLine) {
    if (this.openingGreetingSent || !this.openAi || !this.orchestrator) {
      return;
    }
    this.openingGreetingSent = true;
    this.clearOpeningFallbackTimer();
    this.callTiming.record("opening_response_requested", this.callSid ?? void 0);
    this.playbackTracker.reset();
    this.activeResponseUsesClosingMark = false;
    const sent = this.requestAssistantSpeech(openingLine, "opening_greeting");
    if (sent) {
      this.orchestrator.markOpeningDelivered();
    }
  }
  beginOpeningReasonListen() {
    this.openingGreetingPlaybackComplete = true;
    this.openingSilence.beginListeningForReason();
    this.orchestrator?.onOpeningGreetingComplete();
    this.scheduleOpeningSilenceReprompt();
    const queued = this.queuedOpeningTranscript;
    this.queuedOpeningTranscript = null;
    if (queued) {
      void this.processCallerTranscriptAfterOpeningListen(queued);
    }
  }
  async processCallerTranscriptAfterOpeningListen(transcript) {
    if (!this.orchestrator?.isOpeningGreetingPlaybackComplete()) {
      return;
    }
    if (this.openingSilence.isListeningForReason() && !isMeaningfulOpeningCallerTranscript(transcript)) {
      this.scheduleOpeningSilenceReprompt();
      return;
    }
    const itemId = `queued-opening-${Date.now()}`;
    if (!this.responseGuard.registerCallerTranscript(itemId)) {
      return;
    }
    if (isMeaningfulOpeningCallerTranscript(transcript)) {
      this.openingSilence.onMeaningfulCallerTranscript();
      this.responseGuard.completeOpeningReasonListen();
    }
    this.processCallerTurnReply(transcript);
  }
  scheduleOpeningSilenceReprompt() {
    this.openingSilence.scheduleSilenceCheck((prompt) => {
      this.handleOpeningSilencePrompt(prompt);
    });
  }
  handleOpeningSilencePrompt(prompt) {
    if (this.closed || !this.openingSilence.isListeningForReason()) {
      return;
    }
    if (prompt === OPENING_SILENCE_GOODBYE) {
      this.requestAssistantSpeech(prompt, "opening_silence_reprompt");
      this.cleanup("opening_silence_timeout");
      return;
    }
    const sent = this.requestAssistantSpeech(prompt, "opening_silence_reprompt");
    if (sent) {
      this.scheduleOpeningSilenceReprompt();
    }
  }
  requestAssistantSpeech(text, reason, options = {}) {
    if (!this.openAi) {
      return false;
    }
    const turnId = options.turnId ?? this.activeTurnId;
    const sent = this.openAi.speakScript(
      text,
      reason,
      (triggerReason) => this.responseGuard.canTriggerResponse(triggerReason),
      (triggerReason) => {
        this.pendingClientResponse = true;
        this.responseGuard.recordTrigger(triggerReason, turnId);
        this.responseCreateCount += 1;
        if (reason === "opening_greeting") {
          this.openingResponseCreateCount += 1;
        } else if (this.orchestrator?.hasMeaningfulCallerTranscript()) {
          this.postOpeningResponseCreateCount += 1;
        }
        this.turnTiming.record("response_create_sent", this.callSid ?? void 0, { turnId });
        logResponseCreateSent();
      }
    );
    if (sent === "sent") {
      this.playbackTracker.reset();
      this.activeResponseUsesClosingMark = options.hangupAfterMark ?? false;
      this.awaitingClosingMark = options.hangupAfterMark ?? false;
      if (options.hangupAfterMark) {
        this.responseGuard.beginClosingMarkWait();
      }
    }
    return sent === "sent";
  }
  enqueueOrSpeakSpeech(request, options = {}) {
    const conversationState = this.orchestrator?.getConversationState() ?? "collecting_intake";
    const sanitizedText = blockClosingPhraseForConversationState(
      conversationState,
      request.text
    ).trim();
    const turnId = options.turnId ?? this.activeTurnId;
    if (!sanitizedText) {
      if (request.reason === "closing_message") {
        return false;
      }
      logWarn("closing_phrase_blocked_during_intake", {
        callSid: this.callSid ?? void 0,
        conversationState,
        reason: request.reason
      });
      if (request.reason === "caller_turn_reply") {
        return this.requestAssistantSpeech(
          "Thanks for your patience. Could you tell me what the roofing team can help you with?",
          request.reason,
          { hangupAfterMark: request.hangupAfterMark, turnId }
        );
      }
      return false;
    }
    const sent = this.requestAssistantSpeech(
      sanitizedText,
      request.reason,
      {
        hangupAfterMark: request.hangupAfterMark,
        turnId
      }
    );
    if (sent) {
      if (request.hangup && !request.hangupAfterMark) {
        this.cleanup("call_completed");
      } else if (request.reason === "caller_turn_reply" && !this.openingSilence.isListeningForReason()) {
        this.scheduleResponseWatchdog(turnId, { ...request, text: sanitizedText });
      }
      return true;
    }
    this.pendingSpeech = { ...request, text: sanitizedText };
    logWarn("caller_turn_reply_deferred", { callSid: this.callSid ?? void 0, turnId });
    return false;
  }
  flushPendingSpeech() {
    if (!this.pendingSpeech || !this.openAi) {
      return;
    }
    if (!this.responseGuard.canTriggerResponse(this.pendingSpeech.reason)) {
      return;
    }
    const pending = this.pendingSpeech;
    this.pendingSpeech = null;
    const sent = this.enqueueOrSpeakSpeech(pending);
    if (!sent && pending) {
      this.pendingSpeech = pending;
    }
  }
  handleStreamMedia(payload) {
    if (!payload || !this.openAi) {
      return;
    }
    this.openAi.appendCallerAudio(payload);
  }
  handleOpenAiEvent(event) {
    switch (event.type) {
      case "session.updated":
        this.callTiming.record("openai_session_ready", this.callSid ?? void 0);
        logInfo("openai_session_ready", { type: event.type });
        break;
      case "input_audio_buffer.speech_started":
        this.responseGuard.onCallerSpeechStarted();
        this.bargeIn?.handleCallerSpeechStarted();
        break;
      case "input_audio_buffer.speech_stopped":
        this.activeTurnId += 1;
        this.responseGuard.beginCallerTurn(this.activeTurnId);
        this.turnTiming.beginTurn(this.callSid ?? void 0, this.activeTurnId);
        this.turnTiming.record("speech_stopped", this.callSid ?? void 0, {
          turnId: this.activeTurnId
        });
        break;
      case "conversation.item.input_audio_transcription.completed":
        void this.handleTranscriptionCompleted(event);
        break;
      case "response.created": {
        if (this.pendingClientResponse) {
          this.pendingClientResponse = false;
        } else {
          logWarn("vad_auto_response_cancelled");
          this.openAi?.cancelActiveResponse();
          this.responseGuard.onResponseCancelled();
          break;
        }
        const responseId = event.response?.id;
        if (responseId) {
          this.bargeIn?.handleResponseStarted(
            responseId,
            this.openAi?.getActiveItemId() ?? null
          );
        }
        break;
      }
      case "response.output_audio.delta": {
        const delta = String(event.delta ?? "");
        if (this.responseGuard.isStaleResponseAudio(this.activeTurnId)) {
          logWarn("stale_audio_delta_ignored", {
            callSid: this.callSid ?? void 0,
            activeTurnId: this.activeTurnId,
            responseTurnId: this.responseGuard.getResponseTurnId()
          });
          break;
        }
        this.clearResponseWatchdog();
        this.turnTiming.record("first_audio_received", this.callSid ?? void 0, {
          turnId: this.activeTurnId
        });
        logFirstAssistantAudioReceived();
        this.responseGuard.onAssistantAudioDelta();
        this.forwardAssistantAudio(delta);
        break;
      }
      case "response.output_audio.done":
        logInfo("response_output_audio_done");
        this.responseGuard.onAssistantAudioDone();
        if (this.awaitingClosingMark && this.streamSid) {
          this.sendTwilioJson(
            buildTwilioMarkMessage(this.streamSid, CLOSING_MARK_NAME)
          );
          this.awaitingClosingMark = false;
        }
        break;
      case "response.done":
        this.bargeIn?.handleResponseCompleted();
        this.responseGuard.onResponseDone();
        if (this.responseGuard.wasLastResponseOpeningGreeting()) {
          this.beginOpeningReasonListen();
          this.orchestrator?.onAssistantResponseDone();
          this.clearResponseWatchdog();
          this.pendingSpeech = null;
          break;
        }
        if (this.responseGuard.getLastTriggerReason() === "opening_silence_reprompt") {
          this.scheduleOpeningSilenceReprompt();
        }
        this.orchestrator?.onAssistantResponseDone();
        this.clearResponseWatchdog();
        this.flushPendingSpeech();
        void this.processQueuedCallerTranscript();
        break;
      case "response.failed":
        logWarn("openai_response_failed", { callSid: this.callSid ?? void 0 });
        this.bargeIn?.handleResponseCancelled();
        this.responseGuard.onResponseFailed();
        this.pendingClientResponse = false;
        this.awaitingClosingMark = false;
        this.clearResponseWatchdog();
        this.flushPendingSpeech();
        void this.processQueuedCallerTranscript();
        break;
      case "response.cancelled":
      case "response.canceled":
        this.bargeIn?.handleResponseCancelled();
        this.responseGuard.onResponseCancelled();
        this.pendingClientResponse = false;
        this.awaitingClosingMark = false;
        this.clearResponseWatchdog();
        this.flushPendingSpeech();
        void this.processQueuedCallerTranscript();
        break;
      case "error":
        logError("openai_event_error", {
          errorType: String(event.error ?? "unknown")
        });
        this.responseGuard.onOpenAiError();
        this.pendingClientResponse = false;
        this.clearResponseWatchdog();
        this.flushPendingSpeech();
        void this.processQueuedCallerTranscript();
        break;
      default:
        break;
    }
  }
  handleTranscriptionCompleted(event) {
    const transcript = String(
      event.transcript ?? (event.item?.transcript ?? "")
    ).trim();
    if (!transcript || !this.orchestrator || !this.openAi) {
      return;
    }
    if (this.openingGreetingSent && !this.openingGreetingPlaybackComplete) {
      this.queuedOpeningTranscript = transcript;
      logInfo("opening_transcript_queued_until_greeting_done", {
        callSid: this.callSid ?? void 0,
        transcriptLength: transcript.length
      });
      return;
    }
    if (this.openingSilence.isListeningForReason() && !isMeaningfulOpeningCallerTranscript(transcript)) {
      logInfo("opening_transcript_ignored_at_bridge", {
        callSid: this.callSid ?? void 0,
        transcriptLength: transcript.length
      });
      this.scheduleOpeningSilenceReprompt();
      return;
    }
    const itemId = String(
      event.item_id ?? (event.item?.id ?? "")
    );
    if (!this.responseGuard.registerCallerTranscript(itemId || null)) {
      return;
    }
    logInfo("caller_transcription_completed", {
      callSid: this.callSid ?? void 0,
      transcriptLength: transcript.length
    });
    this.turnTiming.record("transcript_completed", this.callSid ?? void 0, {
      turnId: this.activeTurnId
    });
    beginTurnDiagnostic(this.callSid ?? "unknown", this.activeTurnId);
    if (isMeaningfulOpeningCallerTranscript(transcript)) {
      this.openingSilence.onMeaningfulCallerTranscript();
      this.responseGuard.completeOpeningReasonListen();
    }
    void this.processCallerTurnReply(transcript);
  }
  scheduleResponseWatchdog(turnId, request) {
    if (this.openingSilence.isListeningForReason()) {
      return;
    }
    this.clearResponseWatchdog();
    this.responseWatchdogTurnId = turnId;
    this.responseWatchdogRequest = request;
    this.responseWatchdogRetryUsed = false;
    this.responseWatchdogTimer = setTimeout(() => {
      this.handleResponseWatchdogTimeout(turnId);
    }, RESPONSE_WATCHDOG_MS);
  }
  clearResponseWatchdog() {
    if (this.responseWatchdogTimer) {
      clearTimeout(this.responseWatchdogTimer);
      this.responseWatchdogTimer = null;
    }
    this.responseWatchdogTurnId = null;
    this.responseWatchdogRequest = null;
    this.responseWatchdogRetryUsed = false;
  }
  handleResponseWatchdogTimeout(turnId) {
    if (this.closed || this.responseWatchdogTurnId !== turnId) {
      return;
    }
    if (this.turnTiming.hasFirstAudio()) {
      return;
    }
    if (this.responseWatchdogRetryUsed) {
      logWarn("response_watchdog_exhausted", {
        callSid: this.callSid ?? void 0,
        turnId
      });
      this.responseGuard.releaseActiveResponse({
        waitingForCaller: true,
        preserveCallerTurnReady: true
      });
      return;
    }
    const request = this.responseWatchdogRequest;
    if (!request) {
      return;
    }
    logWarn("response_watchdog_retry", {
      callSid: this.callSid ?? void 0,
      turnId
    });
    this.responseWatchdogRetryUsed = true;
    this.responseGuard.prepareCallerTurnRecovery();
    this.pendingClientResponse = false;
    this.enqueueOrSpeakSpeech(request, { turnId });
  }
  attemptEmptyReplyRecovery(transcript) {
    logWarn("caller_turn_empty_reply_recovery", {
      callSid: this.callSid ?? void 0,
      transcriptLength: transcript.length,
      turnId: this.activeTurnId
    });
    this.responseGuard.prepareCallerTurnRecovery();
    this.enqueueOrSpeakSpeech({
      text: "Thanks for your patience. Could you repeat that last answer for me?",
      reason: "caller_turn_reply"
    });
  }
  processCallerTurnReply(transcript) {
    if (!this.orchestrator || !this.openAi) {
      return;
    }
    const turnId = this.activeTurnId;
    void this.orchestrator.handleCallerTranscript(transcript, this.activeTurnId).then((result) => {
      if (this.turnTiming.isStaleTurn(turnId)) {
        return;
      }
      this.turnTiming.record("caller_turn_processed", this.callSid ?? void 0, { turnId });
      if (!result?.replyText) {
        if (this.openingSilence.isListeningForReason()) {
          return;
        }
        this.attemptEmptyReplyRecovery(transcript);
        return;
      }
      if (result.structuredStateUpdated) {
        this.turnTiming.record("structured_state_updated", this.callSid ?? void 0, { turnId });
      }
      this.turnTiming.record("next_question_selected", this.callSid ?? void 0, { turnId });
      this.turnTiming.record("response_requested", this.callSid ?? void 0, { turnId });
      const reason = result.hangupAfterMark ? "closing_message" : "caller_turn_reply";
      this.enqueueOrSpeakSpeech(
        {
          text: result.replyText,
          reason,
          hangupAfterMark: result.hangupAfterMark,
          hangup: result.hangup
        },
        { turnId }
      );
    }).catch((error) => {
      logError("caller_turn_processing_failed", { callSid: this.callSid ?? void 0, turnId }, error);
      this.responseGuard.prepareCallerTurnRecovery();
      this.enqueueOrSpeakSpeech(
        {
          text: "Thanks for your patience. Could you repeat that last answer for me?",
          reason: "caller_turn_reply"
        },
        { turnId }
      );
    });
  }
  async processQueuedCallerTranscript() {
    if (!this.orchestrator || !this.orchestrator.hasPendingTranscript()) {
      return;
    }
    if (this.openingSilence.isListeningForReason()) {
      return;
    }
    if (!this.responseGuard.isWaitingForCaller()) {
      return;
    }
    const pending = this.orchestrator.consumePendingTranscript();
    if (!pending) {
      return;
    }
    if (!this.responseGuard.registerCallerTranscript(`queued-${Date.now()}`)) {
      return;
    }
    logInfo("caller_transcript_dequeued", { callSid: this.callSid ?? void 0 });
    this.processCallerTurnReply(pending);
  }
  forwardAssistantAudio(base64Audio) {
    if (!base64Audio || !this.streamSid) {
      return;
    }
    const payloadBuffer = Buffer.from(base64Audio, "base64");
    this.playbackTracker.recordOutboundBytes(payloadBuffer.length);
    this.sendTwilioJson(
      buildTwilioMediaMessage(this.streamSid, base64Audio)
    );
    this.turnTiming.record("first_audio_sent_to_twilio", this.callSid ?? void 0, {
      turnId: this.activeTurnId
    });
    this.callTiming.record("first_audio_sent_to_twilio", this.callSid ?? void 0);
    if (!this.activeResponseUsesClosingMark) {
      this.markCounter += 1;
      this.sendTwilioJson(
        buildTwilioMarkMessage(
          this.streamSid,
          `assistant-${this.markCounter}`
        )
      );
    }
  }
  handleTwilioMark(name) {
    logInfo("twilio_mark_received", { mark: name });
    if (name === CLOSING_MARK_NAME) {
      logInfo("closing_mark_played", { callSid: this.callSid ?? void 0 });
      this.orchestrator?.onClosingMarkPlayed();
      this.responseGuard.onClosingMarkReceived();
      this.cleanup("call_completed");
    }
  }
  sendTwilioJson(payload) {
    if (this.closed || this.params.twilioSocket.readyState !== this.params.twilioSocket.OPEN) {
      return;
    }
    try {
      this.params.twilioSocket.send(JSON.stringify(payload));
    } catch (error) {
      logError("twilio_send_failed", {}, error);
    }
  }
  sendTwilioClose() {
    if (this.params.twilioSocket.readyState === this.params.twilioSocket.OPEN) {
      this.params.twilioSocket.close(1008, "unauthorized");
    }
  }
  cleanup(reason) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    logCallDisconnect({
      callId: this.callSid ?? void 0,
      reason,
      conversationState: this.orchestrator?.getConversationState() ?? null,
      lastSnapshot: getLastTurnDiagnosticSnapshot(),
      callerHeardMessage: reason === "call_completed" || reason.includes("closing"),
      leadPreserved: true
    });
    logInfo("call_bridge_cleanup", { reason, callSid: this.callSid ?? void 0 });
    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }
    this.clearOpeningFallbackTimer();
    this.clearResponseWatchdog();
    this.openingSilence.reset();
    this.pendingSpeech = null;
    this.responseGuard.onWebSocketClosed();
    this.openAi?.close();
    this.openAi = null;
    if (this.params.twilioSocket.readyState === this.params.twilioSocket.OPEN) {
      this.params.twilioSocket.close(1e3, reason);
    }
  }
};

// src/server.ts
var config = getConfig();
try {
  assertBridgeConfig(config);
} catch (error) {
  logError("bridge_config_invalid", {}, error);
  process.exit(1);
}
var server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("not found");
});
var wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname !== config.mediaPath) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (websocket) => {
    wss.emit("connection", websocket, request);
  });
});
wss.on("connection", (twilioSocket) => {
  const bridge = new CallBridge({ twilioSocket, config });
  bridge.start();
});
server.listen(config.port, () => {
  logInfo("realtime_bridge_listening", {
    port: config.port,
    mediaPath: config.mediaPath,
    bargeInEnabled: config.bargeInEnabled
  });
});
process.on("SIGINT", () => {
  logInfo("realtime_bridge_shutdown");
  wss.close();
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  logInfo("realtime_bridge_shutdown");
  wss.close();
  server.close(() => process.exit(0));
});
