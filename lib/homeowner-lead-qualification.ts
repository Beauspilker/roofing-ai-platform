import type { IntakeAnswers } from "@/lib/intake";
import {
  normalizePostalCode,
  resolvePilotCompanyRouteFromEnv,
} from "@/lib/pilot-routing";
import {
  validateIntakeSubmission,
} from "@/lib/intake";

export type HomeownerQualificationStatus =
  | "qualified"
  | "needs_review"
  | "unqualified";

export type HomeownerQualificationResult =
  | {
      status: "qualified";
      companyId: string;
    }
  | {
      status: "needs_review" | "unqualified";
      reason: string;
    };

export type HomeownerLeadSubmissionInput = IntakeAnswers & {
  consent_to_contact: boolean;
  website?: string;
};

const MIN_DESCRIPTION_LENGTH = 12;
const SPAM_PATTERN = /(https?:\/\/|www\.|viagra|crypto|casino)/i;

export function qualifiesHomeownerDescription(description: string): boolean {
  const trimmed = description.trim();
  return trimmed.length >= MIN_DESCRIPTION_LENGTH && !SPAM_PATTERN.test(trimmed);
}

export function qualifyHomeownerLeadSubmission(
  input: HomeownerLeadSubmissionInput,
): HomeownerQualificationResult {
  if (input.website?.trim()) {
    return {
      status: "unqualified",
      reason: "Submission could not be processed.",
    };
  }

  if (!input.consent_to_contact) {
    return {
      status: "unqualified",
      reason: "Consent to be contacted is required.",
    };
  }

  const validationError = validateIntakeSubmission(input);

  if (validationError) {
    return {
      status: "unqualified",
      reason: validationError,
    };
  }

  if (!input.city.trim() || !input.state.trim()) {
    return {
      status: "unqualified",
      reason: "City and state are required.",
    };
  }

  const postalCode = normalizePostalCode(input.postal_code);

  if (postalCode.length !== 5) {
    return {
      status: "unqualified",
      reason: "Please enter a valid 5-digit ZIP code.",
    };
  }

  const route = resolvePilotCompanyRouteFromEnv({ postalCode: input.postal_code });

  if (route.status === "misconfigured") {
    return {
      status: "unqualified",
      reason: "Lead routing is temporarily unavailable. Please try again later.",
    };
  }

  if (route.status === "outside_territory") {
    return {
      status: "unqualified",
      reason: route.reason,
    };
  }

  if (!qualifiesHomeownerDescription(input.description)) {
    return {
      status: "needs_review",
      reason: "Please provide a clearer description of your roofing issue.",
    };
  }

  return {
    status: "qualified",
    companyId: route.companyId,
  };
}
