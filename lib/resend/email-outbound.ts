import { Resend } from "resend";

export type ResendEmailSendResult =
  | { delivered: true; id: string; simulated: false }
  | { delivered: false; simulated: true; reason: string };

export type SendResendEmailInput = {
  to: string;
  subject: string;
  text: string;
};

function getResendConfig(): { apiKey: string; fromEmail: string } | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail =
    process.env.EMPLOYEE_NOTIFICATION_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim();

  if (!apiKey || !fromEmail) {
    return null;
  }

  return { apiKey, fromEmail };
}

export async function sendResendEmail(
  input: SendResendEmailInput,
): Promise<ResendEmailSendResult> {
  const trimmedTo = input.to.trim();
  const trimmedSubject = input.subject.trim();
  const trimmedText = input.text.trim();

  if (!trimmedTo || !trimmedSubject || !trimmedText) {
    return {
      delivered: false,
      simulated: true,
      reason: "missing_recipient_subject_or_body",
    };
  }

  const config = getResendConfig();

  if (!config) {
    return {
      delivered: false,
      simulated: true,
      reason: "resend_not_configured",
    };
  }

  try {
    const resend = new Resend(config.apiKey);
    const { data, error } = await resend.emails.send({
      from: config.fromEmail,
      to: trimmedTo,
      subject: trimmedSubject,
      text: trimmedText,
    });

    if (error) {
      throw new Error(error.message);
    }

    if (!data?.id) {
      throw new Error("Resend returned no message id.");
    }

    return {
      delivered: true,
      id: data.id,
      simulated: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Resend email failed: ${reason}`);
  }
}

export function isResendEmailConfigured(): boolean {
  return getResendConfig() !== null;
}
