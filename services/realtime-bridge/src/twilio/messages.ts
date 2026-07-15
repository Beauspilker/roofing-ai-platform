export type TwilioStreamEvent =
  | { event: "connected"; protocol?: string; version?: string }
  | {
      event: "start";
      sequenceNumber?: string;
      start: {
        streamSid: string;
        accountSid?: string;
        callSid: string;
        tracks?: string[];
        customParameters?: Record<string, string>;
        mediaFormat?: {
          encoding?: string;
          sampleRate?: number;
          channels?: number;
        };
      };
    }
  | {
      event: "media";
      sequenceNumber?: string;
      media: {
        track?: string;
        chunk?: string;
        timestamp?: string;
        payload: string;
      };
      streamSid?: string;
    }
  | {
      event: "mark";
      sequenceNumber?: string;
      mark: { name: string };
      streamSid?: string;
    }
  | {
      event: "stop";
      sequenceNumber?: string;
      stop?: { accountSid?: string; callSid?: string };
      streamSid?: string;
    };

export type TwilioOutboundMessage =
  | {
      event: "media";
      streamSid: string;
      media: { payload: string };
    }
  | {
      event: "mark";
      streamSid: string;
      mark: { name: string };
    }
  | {
      event: "clear";
      streamSid: string;
    };

export function parseTwilioStreamEvent(raw: string): TwilioStreamEvent | null {
  try {
    const parsed = JSON.parse(raw) as TwilioStreamEvent;

    if (!parsed || typeof parsed !== "object" || !("event" in parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function buildTwilioMediaMessage(
  streamSid: string,
  payload: string,
): TwilioOutboundMessage {
  return {
    event: "media",
    streamSid,
    media: { payload },
  };
}

export function buildTwilioClearMessage(streamSid: string): TwilioOutboundMessage {
  return {
    event: "clear",
    streamSid,
  };
}

export function buildTwilioMarkMessage(
  streamSid: string,
  name: string,
): TwilioOutboundMessage {
  return {
    event: "mark",
    streamSid,
    mark: { name },
  };
}
