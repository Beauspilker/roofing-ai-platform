// src/server.ts
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

// ../../lib/twilio/voice-mode.ts
var DEFAULT_OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview";
var DEFAULT_OPENAI_REALTIME_VOICE = "echo";
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
    bargeInEnabled: isRealtimeBargeInEnabled()
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

// src/openai/realtime-session.ts
import WebSocket from "ws";
var REALTIME_INSTRUCTIONS = "You are the voice interface for Beau's Roofing phone receptionist. You must speak only the exact text provided in each response instruction. Never invent intake questions, never reorder required fields, and never confirm data that was not supplied by the server. Use natural phone prosody and contractions.";
var OpenAiRealtimeSession = class {
  constructor(config2, onEvent, onDisconnect) {
    this.config = config2;
    this.onEvent = onEvent;
    this.onDisconnect = onDisconnect;
  }
  socket = null;
  connected = false;
  connectPromise = null;
  activeResponseId = null;
  activeItemId = null;
  async connect() {
    if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.config.openAiRealtimeModel)}`;
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.openAiApiKey}`,
          "OpenAI-Beta": "realtime=v1"
        }
      });
      this.socket = socket;
      socket.on("open", () => {
        this.connected = true;
        logInfo("openai_connected");
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
        const reason = reasonBuffer.toString() || String(code);
        logWarn("openai_disconnected", { code, reason });
        this.onDisconnect(reason);
      });
    });
    return this.connectPromise;
  }
  configureSession() {
    this.send({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: REALTIME_INSTRUCTIONS,
        voice: this.config.openAiRealtimeVoice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: false
        }
      }
    });
  }
  handleMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      logWarn("openai_malformed_event");
      return;
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
    if (event.type === "response.done" || event.type === "response.cancelled" || event.type === "response.canceled") {
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
  commitCallerAudio() {
    this.send({ type: "input_audio_buffer.commit" });
  }
  speakExactText(exactText) {
    const trimmed = exactText.trim();
    if (!trimmed) {
      return;
    }
    this.send({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        instructions: "Speak the following text exactly word-for-word with natural phone prosody. Do not add, remove, or change any words:\n\n" + trimmed
      }
    });
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
    this.activeResponseId = null;
    this.activeItemId = null;
  }
};

// ../../lib/twilio/helpers.ts
import { NextResponse } from "next/server";

// ../../lib/twilio/voice-config.ts
var DEFAULT_TWILIO_VOICE = "Polly.Joanna";
var ALLOWED_TWILIO_VOICES = /* @__PURE__ */ new Set([
  "Polly.Joanna",
  "Polly.Matthew",
  "Polly.Joanna-Neural",
  "Polly.Matthew-Neural",
  "Polly.Kendra",
  "Polly.Kimberly",
  "Polly.Salli",
  "Polly.Ivy",
  "man",
  "woman",
  "alice"
]);
function resolveTwilioVoice(configured) {
  const trimmed = configured?.trim();
  if (trimmed && ALLOWED_TWILIO_VOICES.has(trimmed)) {
    return trimmed;
  }
  return DEFAULT_TWILIO_VOICE;
}
var TWILIO_VOICE = resolveTwilioVoice(process.env.TWILIO_VOICE);

// ../../lib/twilio/helpers.ts
var OPENING_QUESTION = "What's going on with the roof?";
var OPENING_GREETING = "Hi, thanks for calling Beau's Roofing. I'm the AI assistant here to help. " + OPENING_QUESTION;
var OPENING_RETRY_PROMPT = `I didn't catch that. ${OPENING_QUESTION}`;
var NO_INPUT_FOLLOW_UP_PROMPT = "I didn't catch that. Please go ahead.";
var NO_INPUT_GOODBYE = "Sorry, I couldn't hear you. Please call back when you're ready. Goodbye.";
var MAX_SPEECH_NO_INPUT_ATTEMPTS = 4;
var CALLER_GOODBYE = "Thank you for calling Beau's Roofing. Have a wonderful day.";
var GOODBYE_PHRASES = [
  "goodbye",
  "good bye",
  "bye",
  "that's all",
  "thats all",
  "that is all",
  "no thank you",
  "no thanks",
  "nothing else",
  "i'm good",
  "im good",
  "all set"
];
function isGoodbyePhrase(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return GOODBYE_PHRASES.some(
    (phrase) => normalized === phrase || normalized.includes(phrase)
  );
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

// ../../lib/call-summary.ts
var SUMMARY_DATA_FIELDS = /* @__PURE__ */ new Set([
  "problem_description",
  "full_name",
  "callback_phone",
  "address",
  "project_type",
  "active_leak",
  "storm_damage",
  "insurance_claim",
  "urgency",
  "appointment_preference",
  "additional_notes"
]);
function isSummaryDataField(field) {
  return SUMMARY_DATA_FIELDS.has(field);
}
var FILLER_WORDS = /\b(uh+|um+|uh huh|you know|i mean|kind of|sort of|like|basically|literally|anyway)\b/gi;
var OPENING_FILLER = /^(hey|hi|hello|yeah|yep|so|well|okay|ok|thanks|thank you)[,.]?\s+/i;
var CALL_PREFIX = /^(i'?m calling because|calling because|i wanted to (call|see|ask)|i need to (report|tell you about|let you know))\s+/i;
var UNCERTAIN_PHRASES = /\b(i think|hopefully|maybe|probably|it sounds like|sounds like|i guess|i believe|i feel like)\b/gi;
var SPOKEN_SUMMARY_CONFIRMATION = "Does everything sound correct before I send this to our roofing team?";
var SPOKEN_POST_EDIT_CONFIRMATION = "Does everything else sound correct before I send this to our roofing team?";
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
function reasonToSpoken(reason) {
  return reason.replace(/^Suspected /, "suspected ").replace(/^Storm-related /, "storm-related ").replace(/^Structural /, "structural ").replace(/^Roof /, "roof ").replace(/^Insurance /, "insurance ");
}
function insuranceToSpoken(insurance) {
  if (insurance.includes("already been initiated")) {
    return "You've already opened an insurance claim.";
  }
  if (insurance.includes("not been initiated")) {
    return "You haven't opened an insurance claim yet.";
  }
  return insurance;
}
function appointmentToSpokenShort(appointment) {
  const detail = appointment.replace(/^Requested inspection:?\s*/i, "").trim().toLowerCase();
  return `You'd like a roofing specialist to come ${detail}.`;
}
function leakToSpoken(leak) {
  if (leak.includes("Interior water intrusion affecting")) {
    const location = leak.replace("Interior water intrusion affecting the ", "");
    return `I've also noted interior leaking in the ${location}.`;
  }
  if (leak.includes("Active interior water intrusion")) {
    return "I've also noted active interior water intrusion.";
  }
  if (leak.includes("No active interior")) {
    return "There's no active interior water intrusion right now.";
  }
  return leak;
}
function buildSpokenCallSummary(fields) {
  const content = buildProfessionalSummaryContent(fields);
  const sentences = [];
  if (content.reason) {
    sentences.push(`I have you down for ${reasonToSpoken(content.reason)}.`);
  }
  if (content.location) {
    sentences.push(
      `We'll be inspecting the property at ${content.location}.`
    );
  }
  if (content.contactName) {
    sentences.push(`I have ${content.contactName} as the contact.`);
  }
  if (content.insurance) {
    sentences.push(insuranceToSpoken(content.insurance));
  }
  if (content.appointment) {
    sentences.push(appointmentToSpokenShort(content.appointment));
  }
  if (content.leak) {
    sentences.push(leakToSpoken(content.leak));
  }
  if (content.urgency && content.urgency.includes("urgent")) {
    sentences.push("I've marked this as an urgent priority for our roofing team.");
  }
  if (content.additionalNotes) {
    sentences.push(`I've also noted ${content.additionalNotes.toLowerCase()}.`);
  }
  if (sentences.length === 0) {
    sentences.push("I have your information ready for our roofing team.");
  }
  return `${sentences.join(" ")} ${SPOKEN_SUMMARY_CONFIRMATION}`;
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
function fieldEditLabel(field) {
  switch (field) {
    case "address":
      return "inspection address";
    case "appointment_preference":
      return "appointment time";
    case "full_name":
      return "contact name";
    case "callback_phone":
      return "phone number";
    case "problem_description":
    case "project_type":
    case "storm_damage":
      return "damage details";
    case "active_leak":
      return "water intrusion details";
    case "insurance_claim":
      return "insurance information";
    case "urgency":
      return "priority";
    case "additional_notes":
      return "additional notes";
    default:
      return "information";
  }
}
function fieldUpdateDetailLine(field, fields) {
  const content = buildProfessionalSummaryContent(fields);
  switch (field) {
    case "address":
      return content.location ? `I've updated the inspection address to ${content.location}.` : "I've updated the inspection address.";
    case "appointment_preference": {
      const detail = content.appointment?.replace(/^Requested inspection:?\s*/i, "").trim().toLowerCase();
      return detail ? `I've updated the appointment to ${detail}.` : "I've updated the appointment.";
    }
    case "full_name":
      return content.contactName ? `I've updated the contact name to ${content.contactName}.` : "I've updated the contact name.";
    case "callback_phone":
      return "I've updated the callback phone number.";
    case "problem_description":
    case "project_type":
    case "storm_damage":
      return content.reason ? `I've updated the damage details to ${reasonToSpoken(content.reason)}.` : "I've updated the damage details.";
    case "active_leak":
      return content.leak ? `I've noted ${content.leak.toLowerCase()}.` : "I've noted the water intrusion.";
    case "insurance_claim":
      return content.insurance ? `I've updated the insurance information \u2014 ${content.insurance.toLowerCase()}.` : "I've updated the insurance information.";
    case "urgency":
      return content.urgency ? `I've updated the priority \u2014 ${content.urgency.toLowerCase()}.` : "I've updated the priority.";
    case "additional_notes":
      return content.additionalNotes ? `I've added the note \u2014 ${content.additionalNotes.toLowerCase()}.` : "I've added that note.";
    default:
      return "I've updated that.";
  }
}
function buildSummaryFieldsUpdateReply(fields, updatedFields) {
  if (updatedFields.length === 0) {
    return `No problem. I've updated that. ${SPOKEN_POST_EDIT_CONFIRMATION}`;
  }
  if (updatedFields.length === 1) {
    return `No problem. ${fieldUpdateDetailLine(updatedFields[0], fields)} ${SPOKEN_POST_EDIT_CONFIRMATION}`;
  }
  if (updatedFields.length === 2) {
    return `No problem. I've updated both the ${fieldEditLabel(updatedFields[0])} and the ${fieldEditLabel(updatedFields[1])}. ${SPOKEN_POST_EDIT_CONFIRMATION}`;
  }
  const labels = updatedFields.map(fieldEditLabel);
  const last = labels.pop();
  return `No problem. I've updated the ${labels.join(", the ")}, and the ${last}. ${SPOKEN_POST_EDIT_CONFIRMATION}`;
}
function buildSummaryEditValuePrompt(field) {
  switch (field) {
    case "full_name":
      return "What's the correct name?";
    case "callback_phone":
      return "What's the correct phone number?";
    case "address":
      return "What's the correct address?";
    case "problem_description":
    case "project_type":
    case "storm_damage":
      return "What's the correct damage description?";
    case "active_leak":
      return "Is water currently getting inside?";
    case "insurance_claim":
      return "Have you started an insurance claim, or not yet?";
    case "urgency":
      return "How soon do you need someone out?";
    case "appointment_preference":
      return "What day and time works better?";
    case "additional_notes":
      return "What else should our team know?";
    default:
      return "What should I change it to?";
  }
}
function getSummaryConfirmationPrompt() {
  return SPOKEN_SUMMARY_CONFIRMATION;
}
function getPostEditConfirmationPrompt() {
  return SPOKEN_POST_EDIT_CONFIRMATION;
}
function isPostEditAffirmation(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /\b(sounds? correct|looks? accurate|everything (else )?(is )?(correct|right|good|fine|accurate))\b/.test(
    normalized
  ) || /\beverything else (is )?(correct|right|good|fine)\b/.test(normalized) || /\bnothing else\b/.test(normalized) || /^(that'?s all|thats all|that'?s it|thats it|we'?re good|all set)\b/.test(
    normalized
  ) || /^no,? (that'?s|thats) (all|it)\b/.test(normalized);
}
function isSummaryChangeDeclined(speech) {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  return /^(no|nope|nah|not quite|incorrect|wrong|that'?s wrong|not right)\b/.test(
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
var INTERRUPTION_PAUSE_PATTERN = /^(actually|wait|hold on|hang on|one second|one sec|sorry|let me check|give me a sec)\.?$/i;
var INTERRUPTION_PREFIX_PATTERN = /^(actually|wait|hold on|hang on|one second|one sec|sorry)[,.]?\s+/i;
var CORRECTION_PREFIX_PATTERN = /^(no|actually|wait|not|correction)[,.]?\s+/i;
var SMALL_TALK_PATTERN = /\b(how'?s your day|how are you|how'?s it going|hope you'?re|staying dry|been crazy|pretty crazy|rough day|busy day|^thanks\b|thank you)\b/i;
var FAQ_PATTERNS = [
  {
    topic: "insurance",
    pattern: /\b(work with insurance|insurance company|accept insurance|file a claim|insurance claim work)\b/i
  },
  {
    topic: "service_area",
    pattern: /\b(serve my area|service area|do you cover|come to my area|service my area|in my town)\b/i
  },
  {
    topic: "inspection_cost",
    pattern: /\b(how much|what does it cost|free inspection|charge for|inspection cost|cost of an inspection)\b/i
  },
  {
    topic: "same_day",
    pattern: /\b(come today|same day|someone today|out today|this afternoon|right now|how soon|when can someone come|how quickly)\b/i
  },
  {
    topic: "photos",
    pattern: /\b(send photos|send pictures|text photos|email photos|upload photos|share photos|take pictures)\b/i
  }
];
var EMERGENCY_PATTERN = /\b(tree through|through the roof|roof collapse|collapsed|caved in|water pouring|pouring in|ceiling leaking badly|electrical hazard|spark|storm happening now|active storm|emergency|urgent|asap)\b/i;
function isInterruptionPause(speech) {
  return INTERRUPTION_PAUSE_PATTERN.test(speech.trim());
}
function stripInterruptionPrefix(speech) {
  return speech.replace(INTERRUPTION_PREFIX_PATTERN, "").trim();
}
function hasCorrectionIntent(speech) {
  const normalized = speech.trim().toLowerCase();
  return CORRECTION_PREFIX_PATTERN.test(normalized) || /\b(not|actually|instead|rather|meant|correction|wrong)\b/.test(normalized);
}
function detectSmallTalk(speech) {
  return SMALL_TALK_PATTERN.test(speech) && speech.trim().split(/\s+/).length <= 14;
}
function buildSmallTalkResponse(speech) {
  if (/^thanks|thank you/i.test(speech.trim())) {
    return "You're welcome.";
  }
  if (/how'?s your day|how are you|how'?s it going/i.test(speech)) {
    return "Doing well, thank you.";
  }
  if (/staying dry|crazy|storm|weather|busy day/i.test(speech)) {
    return "It's been a busy day on our end.";
  }
  if (/hope you'?re/i.test(speech)) {
    return "We appreciate that.";
  }
  return "Thank you.";
}
function detectFaqTopic(speech) {
  for (const entry of FAQ_PATTERNS) {
    if (entry.pattern.test(speech)) {
      return entry.topic;
    }
  }
  return null;
}
function isLikelyFaqOnly(speech) {
  const topic = detectFaqTopic(speech);
  if (!topic) {
    return false;
  }
  return speech.trim().split(/\s+/).length <= 18;
}
function buildFaqResponse(topic) {
  switch (topic) {
    case "insurance":
      return "Yes, we regularly work with insurance claims and can help guide you through the process.";
    case "service_area":
      return "We serve homeowners throughout our local service area, and our team can confirm coverage for your address.";
    case "inspection_cost":
      return "Inspection details depend on the situation, and our team can walk you through that when they follow up.";
    case "same_day":
      return "We'll do our best to get a roofing specialist out quickly, especially for urgent situations.";
    case "photos":
      return "Yes, our team can review photos \u2014 someone will follow up on the best way to send them.";
  }
}
function detectEmergency(speech) {
  return EMERGENCY_PATTERN.test(speech.toLowerCase()) || /water.*(inside|coming in|pouring)|ceiling.*leak/i.test(speech.toLowerCase());
}
function buildEmergencyResponse() {
  return "I'm sorry that's happening. I've marked this as urgent so our team can prioritize it.";
}
function buildInterruptionResume(currentQuestion) {
  if (currentQuestion?.trim()) {
    return `No problem. ${currentQuestion}`;
  }
  return "No problem. Go ahead whenever you're ready.";
}
function buildCombinedResponse(prefixParts, question) {
  const prefix = prefixParts.filter(Boolean).join(" ").trim();
  return prefix ? `${prefix} ${question}` : question;
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
function detectSummaryEditTargets(speech) {
  const lower = speech.toLowerCase();
  const targets = /* @__PURE__ */ new Set();
  if (/\b(address|location|property|street)\b/.test(lower)) {
    targets.add("address");
  }
  if (/\b(name)\b/.test(lower)) {
    targets.add("full_name");
  }
  if (/\b(phone|number|callback)\b/.test(lower)) {
    targets.add("callback_phone");
  }
  if (/\b(appointment|schedule|time|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon)\b/.test(
    lower
  )) {
    targets.add("appointment_preference");
  }
  if (/\b(insurance|claim)\b/.test(lower)) {
    targets.add("insurance_claim");
  }
  if (/\b(leak|water)\b/.test(lower)) {
    targets.add("active_leak");
  }
  if (/\b(damage|hail|wind|storm|roof|shingles)\b/.test(lower)) {
    targets.add("problem_description");
  }
  if (/\b(urgent|urgency|asap|priority)\b/.test(lower)) {
    targets.add("urgency");
  }
  if (/\b(note|notes)\b/.test(lower)) {
    targets.add("additional_notes");
  }
  return [...targets];
}
function extractYesNoValue(text) {
  const normalized = text.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  if (/^(yes|yeah|yep|yup|correct|sure|absolutely)\b/.test(normalized)) {
    return "yes";
  }
  if (/^(no|nope|nah|not|none|negative)\b/.test(normalized)) {
    return "no";
  }
  return null;
}
function applySummaryFieldValue(fields, speech, target, callerPhone) {
  const cleaned = stripInterruptionPrefix(speech).replace(CORRECTION_PREFIX_PATTERN, "").trim();
  const text = cleaned || speech.trim();
  const lower = text.toLowerCase();
  const updated = { ...fields };
  switch (target) {
    case "full_name": {
      const nameMatch = text.match(
        /(?:name is|my name is|i'?m|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2})/i
      );
      if (nameMatch?.[1]) {
        updated.full_name = nameMatch[1].trim();
        return { fields: updated, updated: true, field: target };
      }
      if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2}$/.test(text)) {
        updated.full_name = text;
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "address": {
      const addressMatch = text.match(
        /\b(?:address is|at|to)\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i
      ) ?? text.match(
        /(?:change|update|move|correct|fix).*?(?:address|location|property|street).*?(?:to|is)\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i
      ) ?? text.match(/(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80})/i);
      if (addressMatch?.[1]) {
        updated.address = addressMatch[1].trim();
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "callback_phone": {
      const phone = text.match(
        /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/
      );
      if (phone) {
        updated.callback_phone = phone[0].replace(/\D/g, "").slice(-10);
        return { fields: updated, updated: true, field: target };
      }
      if (callerPhone && /same number|this number/i.test(lower)) {
        updated.callback_phone = callerPhone;
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "appointment_preference": {
      const appointmentMatch = text.match(
        /(?:appointment|inspection|schedule|time).*?(?:to|for|on|is)\s+([^,.]+(?:morning|afternoon|evening)?)/i
      ) ?? text.match(
        /(?:move|change|update).*?(?:appointment|inspection|visit|come).*?(?:to|for|on)\s+([^,.]+)/i
      ) ?? text.match(
        /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday(?:\s+(?:morning|afternoon|evening))?|\d{1,2}\s*(?:am|pm))(?:\s+(?:morning|afternoon|evening))?/i
      );
      if (appointmentMatch?.[1] || appointmentMatch?.[0]) {
        updated.appointment_preference = (appointmentMatch[1] ?? appointmentMatch[0]).trim();
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "insurance_claim": {
      const yesNo = extractYesNoValue(text);
      if (yesNo) {
        updated.insurance_claim = yesNo;
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "active_leak": {
      const yesNo = extractYesNoValue(text);
      if (yesNo) {
        updated.active_leak = yesNo;
        return { fields: updated, updated: true, field: target };
      }
      break;
    }
    case "urgency":
      if (/emergency|urgent|asap|today|flexible|soon|week/i.test(lower)) {
        updated.urgency = lower.includes("flex") ? "flexible" : lower.match(/emergency|urgent|asap|today/) ? "emergency" : "standard";
        return { fields: updated, updated: true, field: target };
      }
      break;
    case "problem_description":
    case "project_type":
    case "storm_damage":
      if (text.length > 3) {
        if (/hail|storm/i.test(lower)) {
          updated.project_type = "storm damage";
          updated.storm_damage = "yes";
        } else if (/wind/i.test(lower)) {
          updated.project_type = "wind damage";
          updated.storm_damage = "yes";
        }
        updated.problem_description = text;
        return { fields: updated, updated: true, field: "problem_description" };
      }
      break;
    case "additional_notes":
      if (text.length > 0 && !/^(no|nope|nah|nothing|none)\b/i.test(lower)) {
        updated.additional_notes = text;
        return { fields: updated, updated: true, field: target };
      }
      break;
  }
  return { fields, updated: false };
}
var SUMMARY_CORRECTION_ORDER = [
  "address",
  "appointment_preference",
  "full_name",
  "callback_phone",
  "insurance_claim",
  "problem_description",
  "active_leak",
  "urgency",
  "additional_notes"
];
function applySummaryCorrections(fields, speech, callerPhone) {
  let working = { ...fields };
  const updatedFields = [];
  for (const target of SUMMARY_CORRECTION_ORDER) {
    const result = applySummaryFieldValue(working, speech, target, callerPhone);
    if (result.updated && result.field) {
      working = result.fields;
      if (!updatedFields.includes(result.field)) {
        updatedFields.push(result.field);
      }
    }
  }
  return { fields: working, updatedFields };
}
function processSummaryEdit(fields, speech, callerPhone) {
  const pendingTarget = typeof fields.summary_edit_target === "string" && isSummaryDataField(fields.summary_edit_target) ? fields.summary_edit_target : null;
  const awaitingValue = fields.summary_editing === true && pendingTarget !== null;
  if (awaitingValue && pendingTarget) {
    const applied = applySummaryFieldValue(
      fields,
      speech,
      pendingTarget,
      callerPhone
    );
    if (applied.updated && applied.field) {
      return {
        status: "updated",
        fields: applied.fields,
        updatedFields: [applied.field]
      };
    }
    return {
      status: "awaiting_value",
      fields,
      target: pendingTarget
    };
  }
  const multi = applySummaryCorrections(fields, speech, callerPhone);
  if (multi.updatedFields.length > 0) {
    return {
      status: "updated",
      fields: multi.fields,
      updatedFields: multi.updatedFields
    };
  }
  const targets = detectSummaryEditTargets(speech);
  if (targets.length === 1) {
    return {
      status: "awaiting_value",
      fields: {
        ...fields,
        summary_editing: true,
        summary_edit_target: targets[0]
      },
      target: targets[0]
    };
  }
  if (targets.length > 1) {
    const combined = applySummaryCorrections(fields, speech, callerPhone);
    if (combined.updatedFields.length > 0) {
      return {
        status: "updated",
        fields: combined.fields,
        updatedFields: combined.updatedFields
      };
    }
    return {
      status: "awaiting_value",
      fields: {
        ...fields,
        summary_editing: true,
        summary_edit_target: targets[0]
      },
      target: targets[0]
    };
  }
  return { status: "unchanged" };
}

// ../../lib/call-intake.ts
var CALL_INTAKE_STAGES = [
  "problem",
  "full_name",
  "callback_phone",
  "address",
  "project_type",
  "active_leak",
  "storm_damage",
  "insurance_claim",
  "urgency",
  "appointment",
  "additional_notes"
];
var STAGE_FIELD_KEYS2 = {
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
var ROUTINE_STAGES = [
  "full_name",
  "callback_phone",
  "address",
  "appointment",
  "insurance_claim",
  "additional_notes"
];
function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function getStringField(fields, fieldKey) {
  const value = fields[fieldKey];
  return typeof value === "string" ? value : void 0;
}
function setStringField(fields, fieldKey, value) {
  return {
    ...fields,
    [fieldKey]: value
  };
}
function fieldText(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}
function isYesValue(value) {
  if (!value) {
    return false;
  }
  return /^(yes|yeah|yep|yup|true|correct|sure)$/i.test(value.trim());
}
function indicatesWaterIntrusion(text) {
  return /water.*(inside|in the|coming|getting in|pouring)|flooding|active leak|leaking inside/i.test(
    text.toLowerCase()
  );
}
function indicatesStructuralEmergency(text) {
  return /tree|through the roof|collapsed|caved|structural|fallen on/i.test(
    text.toLowerCase()
  );
}
function indicatesStormDamage(text) {
  return /hail|storm|wind damage|tornado|hurricane/i.test(text.toLowerCase());
}
function extractActiveLeak(text) {
  if (indicatesWaterIntrusion(text)) {
    return "yes";
  }
  const yesNo = extractYesNo(text);
  if (yesNo && /leak|water|drip/i.test(text.toLowerCase())) {
    return yesNo;
  }
  return null;
}
function extractStormDamage(text) {
  if (indicatesStormDamage(text)) {
    return "yes";
  }
  const yesNo = extractYesNo(text);
  if (yesNo && indicatesStormDamage(text)) {
    return yesNo;
  }
  return null;
}
function getNextMissingStage(fields) {
  for (const stage of CALL_INTAKE_STAGES) {
    const fieldKey = STAGE_FIELD_KEYS2[stage];
    const value = fields[fieldKey];
    if (typeof value !== "string" || !hasValue(value)) {
      return stage;
    }
  }
  return "wrap_up";
}
function isIntakeComplete(fields) {
  return getNextMissingStage(fields) === "wrap_up";
}
function isAwaitingSummaryConfirmation(fields) {
  return isIntakeComplete(fields) && fields.summary_delivered === true && fields.summary_confirmed !== true;
}
function isAwaitingSummaryEditValue(fields) {
  return fields.summary_editing === true && typeof fields.summary_edit_target === "string" && fields.summary_edit_target.length > 0;
}
function clearSummaryEditState(fields) {
  return {
    ...fields,
    summary_editing: false,
    summary_edit_target: void 0
  };
}
function extractYesNo(text) {
  const normalized = text.toLowerCase().replace(/[^\w\s']/g, " ").trim();
  if (/^(yes|yeah|yep|yup|correct|sure|absolutely|affirmative|it is|i am|we are|we do|there is|there's)\b/.test(
    normalized
  )) {
    return "yes";
  }
  if (/^(no|nope|nah|not|none|don't|do not|negative|isn't|aren't|there isn't|there's no)\b/.test(
    normalized
  )) {
    return "no";
  }
  return null;
}
function extractPhone(text) {
  const match = text.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/
  );
  if (!match) {
    return null;
  }
  const digits = match[0].replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}
function extractName(text) {
  const explicit = text.match(
    /(?:my name is|name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2})/
  );
  if (explicit?.[1]) {
    return explicit[1].trim();
  }
  const introduction = text.match(
    /(?:this is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){0,2})(?:\s+(?:and|with|from|at|calling)\b|$)/
  );
  if (introduction?.[1]) {
    return introduction[1].trim();
  }
  return null;
}
function extractAddress(text) {
  const streetMatch = text.match(
    /\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,80}(?:\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|place|pl)\b)?/i
  );
  if (streetMatch) {
    return streetMatch[0].trim();
  }
  const atMatch = text.match(
    /\bat\s+(\d+\s+[A-Za-z0-9][A-Za-z0-9\s,.-]{4,60})/i
  );
  return atMatch?.[1]?.trim() ?? null;
}
function extractProjectType(text) {
  const normalized = text.toLowerCase();
  if (normalized.includes("storm") || normalized.includes("hail")) {
    return "storm damage";
  }
  if (normalized.includes("wind")) {
    return "wind damage";
  }
  if (normalized.includes("replace")) {
    return "replacement";
  }
  if (normalized.includes("repair")) {
    return "repair";
  }
  if (normalized.includes("inspect")) {
    return "inspection";
  }
  return null;
}
function extractInsuranceClaim(text) {
  const lower = text.toLowerCase();
  if (/\b(already|talked to|spoken to|contacted|filed|started|opened|called).*(insurance|claim)\b/.test(
    lower
  ) || /\b(insurance|claim).*(already|started|filed|opened)\b/.test(lower)) {
    return "yes";
  }
  if (/\b(no|not yet|haven't|have not|don't|do not).*(insurance|claim|filed)\b/.test(
    lower
  )) {
    return "no";
  }
  return null;
}
function extractDamageContext(text) {
  const result = {};
  const lower = text.toLowerCase();
  if (/shingles everywhere|shingles all over|missing shingles|loose shingles/i.test(
    lower
  )) {
    result.project_type = "storm damage";
    result.storm_damage = "yes";
    result.problem_description = "loose shingles reported";
  }
  if (/started leaking|began leaking|roof leaking|ceiling leaking|leak/i.test(lower)) {
    if (/yesterday|last night|today|this morning|recently|last week/i.test(lower)) {
      result.problem_description = result.problem_description ?? `roof issue reported ${extractDamageTimingFromText(text) ?? "recently"}`;
    }
    if (/ceiling|kitchen|bathroom|inside|interior|water/i.test(lower)) {
      result.active_leak = "yes";
    }
  }
  if (/yesterday|last night|today|this morning|last week|recently/i.test(lower)) {
    if (/hail|storm|wind|damage|hit|leak/i.test(lower)) {
      result.problem_description = result.problem_description ?? `storm-related roof issue reported ${extractDamageTimingFromText(text) ?? "recently"}`;
      if (/hail|storm|wind/i.test(lower)) {
        result.storm_damage = "yes";
      }
    }
  }
  return result;
}
function extractDamageTimingFromText(text) {
  const lower = text.toLowerCase();
  if (/\byesterday\b/.test(lower)) return "yesterday";
  if (/\blast night\b/.test(lower)) return "last night";
  if (/\bthis morning\b/.test(lower)) return "this morning";
  if (/\btoday\b/.test(lower)) return "today";
  if (/\blast week\b/.test(lower)) return "last week";
  if (/\brecently\b/.test(lower)) return "recently";
  return null;
}
function extractUrgency(text) {
  const normalized = text.toLowerCase();
  if (/emergency|urgent|asap|right away|immediately|today/.test(normalized)) {
    return "emergency";
  }
  if (/flexible|no rush|whenever|next week|few weeks/.test(normalized)) {
    return "flexible";
  }
  if (/standard|few days|this week|soon/.test(normalized)) {
    return "standard";
  }
  return null;
}
function extractCallbackPhone(text, callerPhone) {
  const normalized = text.toLowerCase();
  if (callerPhone && /same number|this number|calling from|number i'?m calling|one i'?m on/.test(
    normalized
  )) {
    return callerPhone;
  }
  return extractPhone(text);
}
function normalizeFieldValue(stage, answer, callerPhone) {
  const trimmed = answer.trim();
  switch (stage) {
    case "active_leak":
    case "storm_damage":
    case "insurance_claim":
      return extractYesNo(trimmed) ?? trimmed;
    case "callback_phone":
      return extractCallbackPhone(trimmed, callerPhone) ?? trimmed;
    case "project_type":
      return extractProjectType(trimmed) ?? trimmed;
    case "urgency":
      return extractUrgency(trimmed) ?? trimmed;
    case "additional_notes":
      if (/^(no|nope|nah|nothing|none|that's all|thats all|all set)\b/i.test(trimmed)) {
        return "none";
      }
      return trimmed;
    default:
      return trimmed;
  }
}
function extractFieldsFromSpeech(text, callerPhone) {
  const extracted = {};
  const name = extractName(text);
  const phone = extractCallbackPhone(text, callerPhone) ?? extractPhone(text);
  const address = extractAddress(text);
  const projectType = extractProjectType(text);
  const urgency = extractUrgency(text);
  if (name) {
    extracted.full_name = name;
  }
  if (phone) {
    extracted.callback_phone = phone;
  }
  if (address) {
    extracted.address = address;
  }
  if (projectType) {
    extracted.project_type = projectType;
  }
  if (urgency) {
    extracted.urgency = urgency;
  }
  const activeLeak = extractActiveLeak(text);
  if (activeLeak) {
    extracted.active_leak = activeLeak;
  }
  const stormDamage = extractStormDamage(text);
  if (stormDamage) {
    extracted.storm_damage = stormDamage;
  }
  const insuranceClaim = extractInsuranceClaim(text);
  if (insuranceClaim) {
    extracted.insurance_claim = insuranceClaim;
  }
  const damageContext = extractDamageContext(text);
  for (const [key, value] of Object.entries(damageContext)) {
    const fieldKey = key;
    const existingValue = extracted[fieldKey];
    if (typeof value === "string" && !(typeof existingValue === "string" && hasValue(existingValue)) && hasValue(value)) {
      extracted[fieldKey] = value;
    }
  }
  if (indicatesWaterIntrusion(text) || /emergency|urgent|asap/i.test(text.toLowerCase())) {
    extracted.urgency = extracted.urgency ?? "emergency";
  }
  return extracted;
}
function mergeCallerAnswer(fields, answer, callerPhone) {
  const currentStage = getNextMissingStage(fields);
  if (hasCorrectionIntent(answer)) {
    const correction = applyTargetedCorrection(
      fields,
      answer,
      currentStage === "wrap_up" ? "wrap_up" : currentStage,
      callerPhone
    );
    if (correction.updated) {
      const corrected = correction.fields;
      if (detectEmergency(answer)) {
        corrected.urgency = corrected.urgency ?? "emergency";
        if (/water|leak|pouring/i.test(answer.toLowerCase())) {
          corrected.active_leak = "yes";
        }
      }
      return corrected;
    }
  }
  const processedAnswer = stripInterruptionPrefix(answer);
  const answeringStage = getNextMissingStage(fields);
  let updated = { ...fields };
  const extracted = extractFieldsFromSpeech(processedAnswer, callerPhone);
  for (const stage of CALL_INTAKE_STAGES) {
    const fieldKey = STAGE_FIELD_KEYS2[stage];
    const extractedValue = extracted[fieldKey];
    if (!hasValue(getStringField(updated, fieldKey)) && typeof extractedValue === "string" && hasValue(extractedValue)) {
      updated = setStringField(updated, fieldKey, extractedValue);
    }
  }
  if (detectEmergency(processedAnswer)) {
    updated.urgency = updated.urgency ?? "emergency";
  }
  if (answeringStage !== "wrap_up") {
    const primaryKey = STAGE_FIELD_KEYS2[answeringStage];
    if (!hasValue(getStringField(updated, primaryKey))) {
      updated = setStringField(
        updated,
        primaryKey,
        normalizeFieldValue(answeringStage, processedAnswer, callerPhone)
      );
    }
  }
  return updated;
}
function countNewlyFilledFields(before, after) {
  let count = 0;
  for (const stage of CALL_INTAKE_STAGES) {
    const fieldKey = STAGE_FIELD_KEYS2[stage];
    if (!hasValue(getStringField(before, fieldKey)) && hasValue(getStringField(after, fieldKey))) {
      count += 1;
    }
  }
  return count;
}
function wasPhraseUsedRecently(phrase, priorPhrases) {
  const normalized = phrase.toLowerCase();
  return priorPhrases.some((entry) => entry.toLowerCase().includes(normalized));
}
function pickContextualEmpathy(answeredStage, answerText, priorPhrases) {
  const text = answerText.toLowerCase();
  if (ROUTINE_STAGES.includes(answeredStage)) {
    return null;
  }
  if (answeredStage === "problem" || answeredStage === "project_type") {
    if (indicatesStructuralEmergency(text)) {
      const phrase = "I've noted this as urgent.";
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }
    if (indicatesWaterIntrusion(text) || detectEmergency(text)) {
      const phrase = buildEmergencyResponse();
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }
    return null;
  }
  if (answeredStage === "active_leak") {
    const yesNo = extractYesNo(answerText);
    if (yesNo && isYesValue(yesNo)) {
      const phrase = buildEmergencyResponse();
      return wasPhraseUsedRecently(phrase, priorPhrases) ? null : phrase;
    }
    return null;
  }
  if (answeredStage === "storm_damage") {
    return null;
  }
  return null;
}
function pickTransitionPrefix(answeredStage, answerText, newlyFilledCount, priorPhrases) {
  if (newlyFilledCount > 1) {
    return null;
  }
  const empathy = pickContextualEmpathy(answeredStage, answerText, priorPhrases);
  if (empathy) {
    return empathy;
  }
  return null;
}
function getStageQuestion(stage, fields = {}, callerPhone) {
  const firstName = fieldText(fields.full_name)?.split(/\s+/)[0];
  switch (stage) {
    case "problem":
      return "What's happening with the roof?";
    case "full_name":
      return "What's your name?";
    case "callback_phone":
      if (firstName) {
        return callerPhone ? `${firstName}, is this number the best one to reach you?` : `What's the best number to reach you, ${firstName}?`;
      }
      return callerPhone ? "Is this number the best one to reach you?" : "What's the best phone number to reach you?";
    case "address":
      return "What address should our roofing team inspect?";
    case "project_type":
      return "Are you looking for a repair, replacement, an inspection, or help with storm damage?";
    case "active_leak":
      return "Is there any interior water intrusion in the home right now?";
    case "storm_damage":
      return "Was this related to recent storm damage?";
    case "insurance_claim":
      return "Have you already started an insurance claim for this damage?";
    case "urgency":
      if (fields.active_leak === "yes" || fields.urgency === "emergency") {
        return "How soon do you need a roofing specialist on-site?";
      }
      return "How soon would you like someone from our roofing team out?";
    case "appointment":
      return "What day and time works best for a roofing specialist to stop by?";
    case "additional_notes":
      return "Is there anything else our roofing team should know?";
    default:
      return null;
  }
}
function buildIntakeResponse(fields, answeredStage, options = {}) {
  const nextStage = getNextMissingStage(fields);
  if (nextStage === "wrap_up") {
    return buildWrapUpSummary(fields);
  }
  const question = getStageQuestion(nextStage, fields, options.callerPhone) ?? "Sorry, could you say that once more?";
  const newlyFilledCount = options.fieldsBefore ? countNewlyFilledFields(options.fieldsBefore, fields) : 1;
  if (answeredStage === "wrap_up") {
    return question;
  }
  const empathy = pickTransitionPrefix(
    answeredStage,
    options.callerAnswer ?? "",
    newlyFilledCount,
    options.priorPhrases ?? []
  );
  return buildCombinedResponse([empathy], question);
}
function buildWrapUpSummary(fields) {
  return buildSpokenCallSummary(fields);
}
function buildConfirmedGoodbye() {
  return "Thank you. Everything has been sent to our roofing team. Someone will reach out shortly. Thank you for calling Beau's Roofing. Have a wonderful day.";
}
function getRecentAssistantPhrases(transcript) {
  if (!transcript) {
    return [];
  }
  return transcript.filter((entry) => entry.role === "assistant").slice(-4).map((entry) => entry.content);
}

// ../../lib/call-name-capture.ts
var MAX_NAME_CONFIRMATION_ATTEMPTS = 3;
var NAME_PREFIX_PATTERN = /^(?:my name is|name is|this is|i am|i'm|it's|it is|call me)\s+/i;
var CORRECTION_PREFIX_PATTERN2 = /^(no|actually|wait|not|correction)[,.]?\s+/i;
function hasText2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isAwaitingNameConfirmation(fields) {
  return hasText2(fields.name_pending_confirmation) && !hasText2(fields.full_name);
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
  const cleaned = stripInterruptionPrefix(text.trim()).replace(CORRECTION_PREFIX_PATTERN2, "").replace(NAME_PREFIX_PATTERN, "").trim();
  if (!cleaned) {
    return null;
  }
  const explicitMatch = cleaned.match(
    /(?:^|\b)(?:my name is|name is|this is|i am|i'm|it's|it is|call me)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i
  );
  if (explicitMatch?.[1]) {
    return normalizePersonName(explicitMatch[1]);
  }
  const directMatch = cleaned.match(
    /^([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})$/
  );
  if (directMatch?.[1]) {
    return normalizePersonName(directMatch[1]);
  }
  const looseMatch = cleaned.match(
    /([A-Za-z]{2,}(?:['-][A-Za-z]{2,})?(?:\s+[A-Za-z]{2,}(?:['-][A-Za-z]{2,})?){0,3})/
  );
  if (looseMatch?.[1]) {
    return normalizePersonName(looseMatch[1]);
  }
  return null;
}
function parseSpeechConfidence(confidence) {
  if (!confidence) {
    return null;
  }
  const parsed = Number.parseFloat(confidence);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
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
function hasText3(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function displayValue(value, fallback = "Not provided") {
  return hasText3(value) ? value.trim() : fallback;
}
function isAffirmative(value) {
  return hasText3(value) && /^(yes|yeah|yep|yup|true|correct|started|filed|active)/i.test(value.trim());
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
  const smsRecipient = hasText3(company.business_phone) ? company.business_phone.trim() : null;
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
function hasText4(value) {
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
  ].filter(hasText4);
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
  if (hasText4(input.fields.appointment_preference)) {
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
function hasText5(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isAffirmative2(value) {
  return hasText5(value) && /^(yes|yeah|yep|yup|true|correct|started|filed|active)/i.test(value.trim());
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
  if (!hasText5(value)) {
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
  if (!hasText5(value)) {
    return false;
  }
  return isAffirmative2(value);
}
function buildPhoneLeadDescription(session, fields) {
  const summary = buildCrmCallSummary(fields);
  const priorityLabel = derivePhoneLeadPriorityLabel(fields);
  const lines = [summary];
  if (hasText5(fields.appointment_preference)) {
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
  if (hasText5(fields.appointment_preference)) {
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

// ../../lib/call-turn-processor.ts
function getEffectiveGatherStage(fields) {
  if (isAwaitingNameConfirmation(fields)) {
    return "full_name";
  }
  return getNextMissingStage(fields);
}
function isNameCaptureTurn(fields) {
  if (isAwaitingNameConfirmation(fields) || fields.name_awaiting_repeat === true) {
    return true;
  }
  return getNextMissingStage(fields) === "full_name";
}
async function persistTurn(callSid, input) {
  const session = await updateCallSession({
    callSid,
    collectedFields: input.collectedFields,
    currentQuestion: input.currentQuestion ?? null,
    transcriptEntry: createTranscriptEntry("caller", input.callerSpeech),
    attemptCount: input.attemptCount
  }) ?? null;
  await updateCallSession({
    callSid,
    transcriptEntry: createTranscriptEntry("assistant", input.assistantReply)
  });
  return session;
}
function getNoInputRetryPrompt(session, callerPhone, isInitial) {
  if (!session) {
    return OPENING_RETRY_PROMPT;
  }
  const fields = session.collected_fields ?? {};
  if (isAwaitingNameConfirmation(fields)) {
    const pending = fields.name_pending_confirmation?.trim();
    if (pending) {
      return `I didn't catch that. ${buildNameConfirmationPrompt(pending)}`;
    }
  }
  if (fields.name_awaiting_repeat) {
    return `I didn't catch that. ${buildNameRepeatPrompt()}`;
  }
  if (isAwaitingSummaryConfirmation(fields)) {
    if (isAwaitingSummaryEditValue(fields)) {
      return `I didn't catch that. ${buildSummaryEditValuePrompt(
        fields.summary_edit_target
      )}`;
    }
    return `I didn't catch that. ${getSummaryConfirmationPrompt()}`;
  }
  const nextStage = getNextMissingStage(fields);
  if (isInitial && nextStage === "problem") {
    return OPENING_RETRY_PROMPT;
  }
  const question = getStageQuestion(nextStage, fields, callerPhone) ?? session.current_question;
  if (question) {
    return `I didn't catch that. ${question}`;
  }
  return NO_INPUT_FOLLOW_UP_PROMPT;
}
function buildResumeReply(fields, callerPhone, session, prefix) {
  const stage = getNextMissingStage(fields ?? {});
  const question = getStageQuestion(stage, fields ?? {}, callerPhone) ?? session.current_question ?? "Let's keep going.";
  return buildCombinedResponse([prefix], question);
}
async function processCallerTurn(input) {
  const {
    callSid,
    callerPhone,
    speechResult,
    speechConfidence,
    attempt,
    isInitial
  } = input;
  let session = input.session;
  let nameConfirmationRequested = false;
  let nameCorrected = false;
  if (!speechResult.trim()) {
    if (callSid) {
      await updateCallSession({
        callSid,
        attemptCount: attempt
      });
    }
    if (attempt >= MAX_SPEECH_NO_INPUT_ATTEMPTS) {
      if (callSid) {
        await completeCallSession(callSid, "failed");
      }
      return {
        kind: "speak_hangup",
        replyText: NO_INPUT_GOODBYE,
        session,
        completionStatus: "failed"
      };
    }
    return {
      kind: "speak_continue",
      replyText: getNoInputRetryPrompt(session, callerPhone, isInitial),
      session,
      gatherStage: session ? getEffectiveGatherStage(session.collected_fields ?? {}) : null
    };
  }
  if (isGoodbyePhrase(speechResult)) {
    if (callSid) {
      await completeCallSession(callSid, "completed");
    }
    return {
      kind: "speak_hangup",
      replyText: CALLER_GOODBYE,
      session,
      completionStatus: "completed"
    };
  }
  if (!session || !callSid) {
    return {
      kind: "speak_continue",
      replyText: "I'm having a little trouble on my end. What's going on with the roof?",
      session
    };
  }
  const fieldsBefore = session.collected_fields ?? {};
  const priorPhrases = getRecentAssistantPhrases(session.transcript);
  const turnIndex = session.transcript?.length ?? 0;
  if (isInterruptionPause(speechResult)) {
    const reply2 = buildInterruptionResume(session.current_question);
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("caller", speechResult)
    });
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply2)
    });
    return { kind: "speak_continue", replyText: reply2, session };
  }
  if (isAwaitingSummaryConfirmation(fieldsBefore)) {
    const awaitingEditValue = isAwaitingSummaryEditValue(fieldsBefore);
    if (!awaitingEditValue && (isConfirmationPhrase(speechResult) || isPostEditAffirmation(speechResult)) && !hasCorrectionIntent(speechResult)) {
      const reply3 = buildConfirmedGoodbye();
      await updateCallSession({
        callSid,
        collectedFields: clearSummaryEditState({
          ...fieldsBefore,
          summary_confirmed: true
        }),
        transcriptEntry: createTranscriptEntry("caller", speechResult)
      });
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply3)
      });
      await completeCallSession(callSid, "completed");
      return {
        kind: "speak_hangup",
        replyText: reply3,
        session,
        completionStatus: "completed"
      };
    }
    const editOutcome = processSummaryEdit(
      fieldsBefore,
      speechResult,
      callerPhone
    );
    if (editOutcome.status === "updated") {
      const updatedFields2 = clearSummaryEditState(editOutcome.fields);
      const reply3 = buildSummaryFieldsUpdateReply(
        updatedFields2,
        editOutcome.updatedFields
      );
      await updateCallSession({
        callSid,
        collectedFields: updatedFields2,
        currentQuestion: getPostEditConfirmationPrompt(),
        transcriptEntry: createTranscriptEntry("caller", speechResult)
      });
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply3)
      });
      return { kind: "speak_continue", replyText: reply3, session };
    }
    if (editOutcome.status === "awaiting_value") {
      const reply3 = buildSummaryEditValuePrompt(editOutcome.target);
      await updateCallSession({
        callSid,
        collectedFields: editOutcome.fields,
        currentQuestion: reply3,
        transcriptEntry: createTranscriptEntry("caller", speechResult)
      });
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply3)
      });
      return { kind: "speak_continue", replyText: reply3, session };
    }
    if (!awaitingEditValue && isSummaryChangeDeclined(speechResult)) {
      const reply3 = "What would you like to change?";
      await updateCallSession({
        callSid,
        collectedFields: clearSummaryEditState(fieldsBefore),
        currentQuestion: reply3,
        transcriptEntry: createTranscriptEntry("caller", speechResult)
      });
      await updateCallSession({
        callSid,
        transcriptEntry: createTranscriptEntry("assistant", reply3)
      });
      return { kind: "speak_continue", replyText: reply3, session };
    }
    const reply2 = awaitingEditValue ? buildSummaryEditValuePrompt(
      fieldsBefore.summary_edit_target
    ) : getSummaryConfirmationPrompt();
    await updateCallSession({
      callSid,
      currentQuestion: reply2,
      transcriptEntry: createTranscriptEntry("caller", speechResult)
    });
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply2)
    });
    return { kind: "speak_continue", replyText: reply2, session };
  }
  const faqTopic = detectFaqTopic(speechResult);
  if (faqTopic && isLikelyFaqOnly(speechResult)) {
    const reply2 = buildResumeReply(
      fieldsBefore,
      callerPhone,
      session,
      buildFaqResponse(faqTopic)
    );
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("caller", speechResult)
    });
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply2)
    });
    return { kind: "speak_continue", replyText: reply2, session };
  }
  if (detectSmallTalk(speechResult)) {
    const reply2 = buildResumeReply(
      fieldsBefore,
      callerPhone,
      session,
      buildSmallTalkResponse(speechResult)
    );
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("caller", speechResult)
    });
    await updateCallSession({
      callSid,
      transcriptEntry: createTranscriptEntry("assistant", reply2)
    });
    return { kind: "speak_continue", replyText: reply2, session };
  }
  if (isNameCaptureTurn(fieldsBefore)) {
    const nameOutcome = processNameCaptureTurn({
      fields: fieldsBefore,
      speech: speechResult,
      confidence: parseSpeechConfidence(speechConfidence)
    });
    nameConfirmationRequested = nameOutcome.nameConfirmationRequested;
    nameCorrected = nameOutcome.nameCorrected;
    if (nameOutcome.status === "confirm" || nameOutcome.status === "repeat") {
      session = await persistTurn(callSid, {
        collectedFields: nameOutcome.fields,
        currentQuestion: nameOutcome.replyText,
        callerSpeech: speechResult,
        assistantReply: nameOutcome.replyText,
        attemptCount: 1
      }) ?? session;
      return {
        kind: "speak_continue",
        replyText: nameOutcome.replyText,
        session,
        nameConfirmationRequested,
        nameCorrected,
        gatherStage: "full_name"
      };
    }
    const confirmedFields = nameOutcome.fields;
    const answeredStage2 = "full_name";
    const nextStage2 = getNextMissingStage(confirmedFields);
    if (nextStage2 === "wrap_up") {
      const summary = buildWrapUpSummary(confirmedFields);
      session = await persistTurn(callSid, {
        collectedFields: {
          ...confirmedFields,
          summary_delivered: true
        },
        currentQuestion: getSummaryConfirmationPrompt(),
        callerSpeech: speechResult,
        assistantReply: summary
      }) ?? session;
      return {
        kind: "speak_continue",
        replyText: summary,
        session,
        nameConfirmationRequested,
        nameCorrected,
        gatherStage: "wrap_up"
      };
    }
    const reply2 = buildIntakeResponse(confirmedFields, answeredStage2, {
      callerPhone,
      turnIndex,
      fieldsBefore,
      callerAnswer: speechResult,
      priorPhrases
    });
    session = await persistTurn(callSid, {
      collectedFields: confirmedFields,
      currentQuestion: getStageQuestion(nextStage2, confirmedFields, callerPhone),
      callerSpeech: speechResult,
      assistantReply: reply2
    }) ?? session;
    return {
      kind: "speak_continue",
      replyText: reply2,
      session,
      nameConfirmationRequested,
      nameCorrected,
      gatherStage: nextStage2
    };
  }
  const answeredStage = getNextMissingStage(fieldsBefore);
  let updatedFields = mergeCallerAnswer(
    fieldsBefore,
    speechResult,
    callerPhone
  );
  if (detectEmergency(speechResult) && !updatedFields.emergency_acknowledged) {
    updatedFields = {
      ...updatedFields,
      urgency: updatedFields.urgency ?? "emergency",
      emergency_acknowledged: true
    };
  }
  const nextStage = getNextMissingStage(updatedFields);
  if (nextStage === "wrap_up") {
    const summary = buildWrapUpSummary(updatedFields);
    session = await persistTurn(callSid, {
      collectedFields: {
        ...updatedFields,
        summary_delivered: true
      },
      currentQuestion: getSummaryConfirmationPrompt(),
      callerSpeech: speechResult,
      assistantReply: summary,
      attemptCount: 1
    }) ?? session;
    return {
      kind: "speak_continue",
      replyText: summary,
      session,
      gatherStage: "wrap_up"
    };
  }
  const reply = buildIntakeResponse(updatedFields, answeredStage, {
    callerPhone,
    turnIndex,
    fieldsBefore,
    callerAnswer: speechResult,
    priorPhrases
  });
  session = await persistTurn(callSid, {
    collectedFields: updatedFields,
    currentQuestion: getStageQuestion(nextStage, updatedFields, callerPhone),
    callerSpeech: speechResult,
    assistantReply: reply,
    attemptCount: 1
  }) ?? session;
  return {
    kind: "speak_continue",
    replyText: reply,
    session,
    gatherStage: nextStage
  };
}

// src/orchestrator/session-orchestrator.ts
var SessionOrchestrator = class {
  constructor(context) {
    this.context = context;
  }
  session = null;
  attempt = 1;
  isInitial = true;
  processingTurn = false;
  pendingTranscript = null;
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
          currentQuestion: OPENING_QUESTION,
          transcriptEntry: createTranscriptEntry("assistant", OPENING_GREETING)
        });
      }
    } catch (error) {
      logError("session_initialize_failed", { callSid: this.context.callSid }, error);
    }
    logInfo("session_initialized", {
      callSid: this.context.callSid,
      hasSession: Boolean(this.session)
    });
    return OPENING_GREETING;
  }
  async handleCallerTranscript(transcript) {
    const trimmed = transcript.trim();
    if (!trimmed) {
      return null;
    }
    if (this.processingTurn) {
      this.pendingTranscript = trimmed;
      return null;
    }
    this.processingTurn = true;
    try {
      if (!this.session) {
        this.session = await getCallSessionBySid(this.context.callSid);
      }
      const outcome = await processCallerTurn({
        session: this.session,
        callSid: this.context.callSid,
        callerPhone: this.context.callerPhone,
        speechResult: trimmed,
        attempt: this.attempt,
        isInitial: this.isInitial
      });
      this.session = outcome.session;
      this.isInitial = false;
      this.attempt = 1;
      return {
        replyText: outcome.replyText,
        hangup: outcome.kind === "speak_hangup"
      };
    } catch (error) {
      logError("turn_processing_failed", { callSid: this.context.callSid }, error);
      return {
        replyText: "I'm having a little trouble on my end. Could you repeat that for me?",
        hangup: false
      };
    } finally {
      this.processingTurn = false;
      if (this.pendingTranscript) {
        const pending = this.pendingTranscript;
        this.pendingTranscript = null;
        return this.handleCallerTranscript(pending);
      }
    }
  }
  getSession() {
    return this.session;
  }
};

// src/bridge/call-bridge.ts
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
  openAi = null;
  bargeIn = null;
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
        logInfo("twilio_mark_received", { mark: event.mark.name });
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
    logInfo("twilio_stream_started", {
      callSid: start.callSid,
      streamSid: start.streamSid
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
      await this.openAi.connect();
      const openingLine = await this.orchestrator.initialize();
      this.openAi.speakExactText(openingLine);
    } catch (error) {
      logError("stream_start_setup_failed", { callSid: start.callSid }, error);
      this.cleanup("stream_start_setup_failed");
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
      case "session.created":
      case "session.updated":
        logInfo("openai_session_ready", { type: event.type });
        break;
      case "input_audio_buffer.speech_started":
        this.bargeIn?.handleCallerSpeechStarted();
        break;
      case "input_audio_buffer.speech_stopped":
        this.openAi?.commitCallerAudio();
        break;
      case "conversation.item.input_audio_transcription.completed":
        void this.handleTranscriptionCompleted(event);
        break;
      case "response.created": {
        const responseId = event.response?.id;
        if (responseId) {
          this.bargeIn?.handleResponseStarted(
            responseId,
            this.openAi?.getActiveItemId() ?? null
          );
        }
        break;
      }
      case "response.audio.delta": {
        const delta = String(event.delta ?? "");
        this.forwardAssistantAudio(delta);
        break;
      }
      case "response.audio.done":
        logInfo("response_audio_done");
        break;
      case "response.done":
        this.bargeIn?.handleResponseCompleted();
        break;
      case "response.cancelled":
      case "response.canceled":
        this.bargeIn?.handleResponseCancelled();
        break;
      case "error":
        logError("openai_event_error", {
          errorType: String(event.error ?? "unknown")
        });
        break;
      default:
        break;
    }
  }
  async handleTranscriptionCompleted(event) {
    const transcript = String(
      event.transcript ?? (event.item?.transcript ?? "")
    ).trim();
    if (!transcript || !this.orchestrator || !this.openAi) {
      return;
    }
    logInfo("caller_transcription_completed", {
      callSid: this.callSid ?? void 0,
      transcriptLength: transcript.length
    });
    const result = await this.orchestrator.handleCallerTranscript(transcript);
    if (!result?.replyText) {
      return;
    }
    this.playbackTracker.reset();
    this.openAi.speakExactText(result.replyText);
    if (result.hangup) {
      setTimeout(() => this.cleanup("call_completed"), 1500);
    }
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
    this.markCounter += 1;
    this.sendTwilioJson(
      buildTwilioMarkMessage(
        this.streamSid,
        `assistant-${this.markCounter}`
      )
    );
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
    logInfo("call_bridge_cleanup", { reason, callSid: this.callSid ?? void 0 });
    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }
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
