import twilio from "twilio";

function getTwilioAuthToken(): string | null {
  return process.env.TWILIO_AUTH_TOKEN?.trim() || null;
}

function buildValidationUrl(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const { pathname, search } = new URL(request.url);

  if (forwardedHost) {
    const host = forwardedHost.split(",")[0]?.trim();
    return `${forwardedProto}://${host}${pathname}${search}`;
  }

  return request.url;
}

function formDataToParams(formData: FormData): Record<string, string> {
  const params: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }

  return params;
}

export function validateTwilioRequest(
  request: Request,
  formData: FormData,
): boolean {
  const authToken = getTwilioAuthToken();
  const signature = request.headers.get("x-twilio-signature");

  if (!authToken) {
    console.warn(
      "Twilio signature validation skipped: TWILIO_AUTH_TOKEN is not configured.",
    );
    return true;
  }

  if (!signature) {
    console.error("Twilio signature validation failed: missing X-Twilio-Signature.");
    return false;
  }

  const isValid = twilio.validateRequest(
    authToken,
    signature,
    buildValidationUrl(request),
    formDataToParams(formData),
  );

  if (!isValid) {
    console.error("Twilio signature validation failed.");
  }

  return isValid;
}
