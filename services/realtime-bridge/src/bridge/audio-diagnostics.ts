import { logInfo, logWarn } from "../logger.js";

const RESPONSE_CREATE_TO_FIRST_DELTA_WARN_MS = 2_000;
const AUDIO_DELTA_GAP_WARN_MS = 750;
const EVENT_LOOP_LAG_WARN_MS = 100;

export type AudioDiagnosticContext = {
  callId: string;
  turnId?: number;
};

function baseFields(context: AudioDiagnosticContext): Record<string, string | number | boolean> {
  return {
    callId: context.callId,
    ...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
  };
}

export function parseTwilioSequenceNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function detectTwilioSequenceGap(
  previous: number | null,
  current: number | null,
): number | null {
  if (previous === null || current === null) {
    return null;
  }

  const gap = current - previous;
  return gap > 1 ? gap : null;
}

export class CallAudioDiagnostics {
  private callId = "unknown";
  private activeTurnId: number | null = null;
  private twilioInboundSequence: number | null = null;
  private lastTwilioInboundAt: number | null = null;
  private lastTwilioOutboundAt: number | null = null;
  private twilioInboundFrames = 0;
  private twilioOutboundFrames = 0;
  private openAiSocketState = "unknown";
  private twilioSocketState = "unknown";
  private lastOpenAiDeltaAt: number | null = null;
  private openAiDeltaCountThisTurn = 0;
  private responseCreateAt: number | null = null;
  private responseCreateTurnId: number | null = null;
  private discardedDeltaCount = 0;
  private bargeInCount = 0;
  private truncationCount = 0;
  private outboundBlockedNotOpenCount = 0;
  private twilioSendErrorCount = 0;
  private eventLoopProbeTimer: NodeJS.Timeout | null = null;
  private eventLoopProbeExpectedAt: number | null = null;
  private maxEventLoopLagMs = 0;

  beginCall(callId: string): void {
    this.callId = callId;
    this.twilioSocketState = "open";
    logInfo("audio_diag_call_started", baseFields({ callId }));
    this.startEventLoopProbe();
  }

  endCall(reason: string): void {
    logInfo("audio_diag_call_ended", {
      ...baseFields({ callId: this.callId }),
      reason,
      twilioInboundFrames: this.twilioInboundFrames,
      twilioOutboundFrames: this.twilioOutboundFrames,
      discardedDeltaCount: this.discardedDeltaCount,
      bargeInCount: this.bargeInCount,
      truncationCount: this.truncationCount,
      outboundBlockedNotOpenCount: this.outboundBlockedNotOpenCount,
      twilioSendErrorCount: this.twilioSendErrorCount,
      maxEventLoopLagMs: this.maxEventLoopLagMs,
      openAiSocketState: this.openAiSocketState,
      twilioSocketState: this.twilioSocketState,
    });
    this.stopEventLoopProbe();
  }

  setTwilioSocketState(state: string, reason?: string): void {
    this.twilioSocketState = state;
    logInfo("audio_diag_twilio_socket_state", {
      ...baseFields({ callId: this.callId }),
      state,
      ...(reason ? { reason } : {}),
    });
  }

  setOpenAiSocketState(state: string, details: Record<string, string | number> = {}): void {
    this.openAiSocketState = state;
    logInfo("audio_diag_openai_socket_state", {
      ...baseFields({ callId: this.callId }),
      state,
      ...details,
    });
  }

  recordTwilioStreamConnected(details: Record<string, string | number | undefined> = {}): void {
    logInfo("audio_diag_twilio_media_stream_connected", {
      ...baseFields({ callId: this.callId }),
      ...details,
    });
  }

  recordTwilioInboundMedia(input: {
    sequenceNumber?: string;
    timestamp?: string;
    payloadBytes: number;
    track?: string;
  }): void {
    const now = Date.now();
    const sequence = parseTwilioSequenceNumber(input.sequenceNumber);
    const gap = detectTwilioSequenceGap(this.twilioInboundSequence, sequence);

    if (gap !== null) {
      logWarn("audio_diag_twilio_media_sequence_gap", {
        ...baseFields({ callId: this.callId }),
        previousSequence: this.twilioInboundSequence ?? undefined,
        currentSequence: sequence ?? undefined,
        skippedFrames: gap - 1,
      });
    }

    const interArrivalMs =
      this.lastTwilioInboundAt === null ? undefined : now - this.lastTwilioInboundAt;

    this.twilioInboundSequence = sequence ?? this.twilioInboundSequence;
    this.lastTwilioInboundAt = now;
    this.twilioInboundFrames += 1;

    if (this.twilioInboundFrames === 1 || this.twilioInboundFrames % 250 === 0) {
      logInfo("audio_diag_twilio_inbound_media", {
        ...baseFields({ callId: this.callId }),
        sequenceNumber: sequence ?? undefined,
        payloadBytes: input.payloadBytes,
        track: input.track,
        interArrivalMs,
        frameCount: this.twilioInboundFrames,
      });
    }
  }

  recordTwilioOutboundMedia(payloadBytes: number): void {
    const now = Date.now();
    const interArrivalMs =
      this.lastTwilioOutboundAt === null ? undefined : now - this.lastTwilioOutboundAt;

    this.lastTwilioOutboundAt = now;
    this.twilioOutboundFrames += 1;

    if (this.twilioOutboundFrames === 1 || this.twilioOutboundFrames % 100 === 0) {
      logInfo("audio_diag_twilio_outbound_media", {
        ...baseFields({ callId: this.callId, turnId: this.activeTurnId ?? undefined }),
        payloadBytes,
        interArrivalMs,
        frameCount: this.twilioOutboundFrames,
      });
    }
  }

  recordTwilioSendBlocked(reason: "socket_not_open" | "send_error"): void {
    if (reason === "socket_not_open") {
      this.outboundBlockedNotOpenCount += 1;
      logWarn("audio_diag_twilio_send_blocked_socket_not_open", {
        ...baseFields({ callId: this.callId, turnId: this.activeTurnId ?? undefined }),
        twilioSocketState: this.twilioSocketState,
        blockedCount: this.outboundBlockedNotOpenCount,
      });
      return;
    }

    this.twilioSendErrorCount += 1;
    logWarn("audio_diag_twilio_send_error", {
      ...baseFields({ callId: this.callId, turnId: this.activeTurnId ?? undefined }),
      errorCount: this.twilioSendErrorCount,
    });
  }

  recordResponseCreate(turnId: number, reason: string): void {
    this.activeTurnId = turnId;
    this.responseCreateTurnId = turnId;
    this.responseCreateAt = Date.now();
    this.openAiDeltaCountThisTurn = 0;
    this.lastOpenAiDeltaAt = null;

    logInfo("audio_diag_response_create", {
      ...baseFields({ callId: this.callId, turnId }),
      reason,
      openAiSocketState: this.openAiSocketState,
    });
  }

  recordOpenAiAudioDelta(turnId: number, deltaBytes: number): void {
    const now = Date.now();

    if (this.responseCreateAt !== null && this.openAiDeltaCountThisTurn === 0) {
      const firstDeltaMs = now - this.responseCreateAt;
      logInfo("audio_diag_first_audio_delta", {
        ...baseFields({ callId: this.callId, turnId }),
        elapsedMs: firstDeltaMs,
        deltaBytes,
      });

      if (firstDeltaMs > RESPONSE_CREATE_TO_FIRST_DELTA_WARN_MS) {
        logWarn("audio_diag_first_audio_delta_slow", {
          ...baseFields({ callId: this.callId, turnId }),
          elapsedMs: firstDeltaMs,
          thresholdMs: RESPONSE_CREATE_TO_FIRST_DELTA_WARN_MS,
        });
      }
    }

    if (this.lastOpenAiDeltaAt !== null) {
      const gapMs = now - this.lastOpenAiDeltaAt;
      if (gapMs > AUDIO_DELTA_GAP_WARN_MS) {
        logWarn("audio_diag_openai_audio_delta_gap", {
          ...baseFields({ callId: this.callId, turnId }),
          gapMs,
          thresholdMs: AUDIO_DELTA_GAP_WARN_MS,
        });
      }
    }

    this.lastOpenAiDeltaAt = now;
    this.openAiDeltaCountThisTurn += 1;
    this.activeTurnId = turnId;
  }

  recordDiscardedOpenAiDelta(turnId: number, reason: string): void {
    this.discardedDeltaCount += 1;
    logWarn("audio_diag_openai_audio_delta_discarded", {
      ...baseFields({ callId: this.callId, turnId }),
      reason,
      discardedCount: this.discardedDeltaCount,
    });
  }

  recordOpenAiResponseEvent(
    type: "response.failed" | "response.cancelled" | "response.canceled" | "response.done",
    turnId?: number,
  ): void {
    logInfo("audio_diag_openai_response_event", {
      ...baseFields({ callId: this.callId, turnId: turnId ?? this.activeTurnId ?? undefined }),
      eventType: type,
      openAiSocketState: this.openAiSocketState,
    });
  }

  recordBargeIn(turnId?: number): void {
    this.bargeInCount += 1;
    logInfo("audio_diag_barge_in", {
      ...baseFields({ callId: this.callId, turnId: turnId ?? this.activeTurnId ?? undefined }),
      count: this.bargeInCount,
    });
  }

  recordTruncation(turnId?: number): void {
    this.truncationCount += 1;
    logInfo("audio_diag_truncation", {
      ...baseFields({ callId: this.callId, turnId: turnId ?? this.activeTurnId ?? undefined }),
      count: this.truncationCount,
    });
  }

  recordOpenAiSendSkipped(payloadType: string, socketState: string): void {
    logWarn("audio_diag_openai_send_skipped", {
      ...baseFields({ callId: this.callId, turnId: this.activeTurnId ?? undefined }),
      payloadType,
      socketState,
    });
  }

  getSnapshotForTests(): {
    twilioInboundFrames: number;
    twilioOutboundFrames: number;
    discardedDeltaCount: number;
    bargeInCount: number;
  } {
    return {
      twilioInboundFrames: this.twilioInboundFrames,
      twilioOutboundFrames: this.twilioOutboundFrames,
      discardedDeltaCount: this.discardedDeltaCount,
      bargeInCount: this.bargeInCount,
    };
  }

  private startEventLoopProbe(): void {
    this.stopEventLoopProbe();
    this.eventLoopProbeExpectedAt = Date.now() + 1_000;
    this.eventLoopProbeTimer = setInterval(() => {
      const expectedAt = this.eventLoopProbeExpectedAt;
      const now = Date.now();
      if (expectedAt !== null) {
        const lagMs = now - expectedAt;
        if (lagMs > EVENT_LOOP_LAG_WARN_MS) {
          this.maxEventLoopLagMs = Math.max(this.maxEventLoopLagMs, lagMs);
          logWarn("audio_diag_event_loop_lag", {
            ...baseFields({ callId: this.callId, turnId: this.activeTurnId ?? undefined }),
            lagMs,
            thresholdMs: EVENT_LOOP_LAG_WARN_MS,
          });
        }
      }
      this.eventLoopProbeExpectedAt = now + 1_000;
    }, 1_000);
    this.eventLoopProbeTimer.unref?.();
  }

  private stopEventLoopProbe(): void {
    if (this.eventLoopProbeTimer) {
      clearInterval(this.eventLoopProbeTimer);
      this.eventLoopProbeTimer = null;
    }
    this.eventLoopProbeExpectedAt = null;
  }
}
