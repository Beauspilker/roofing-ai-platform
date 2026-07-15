import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000;

function getSigningSecret(): string | null {
  return process.env.REALTIME_BRIDGE_SIGNING_SECRET?.trim() || null;
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function createStreamAuthToken(callSid: string): string | null {
  const secret = getSigningSecret();

  if (!secret || !callSid) {
    return null;
  }

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${callSid}:${expiresAt}`;
  const signature = signPayload(payload, secret);

  return `${expiresAt}.${signature}`;
}

export function verifyStreamAuthToken(
  callSid: string,
  token: string | null | undefined,
): boolean {
  const secret = getSigningSecret();

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
  const expected = signPayload(payload, secret);

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

export function hasStreamSigningSecret(): boolean {
  return Boolean(getSigningSecret());
}
