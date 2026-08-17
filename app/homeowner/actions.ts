"use server";

import {
  submitHomeownerLead,
  type HomeownerLeadSubmissionResult,
} from "@/lib/homeowner-lead-submission";
import type { HomeownerLeadSubmissionInput } from "@/lib/homeowner-lead-qualification";

export type SubmitHomeownerLeadState = {
  error: string | null;
  success: boolean;
  message: string | null;
};

export async function submitHomeownerLeadAction(
  input: HomeownerLeadSubmissionInput,
): Promise<SubmitHomeownerLeadState> {
  const result: HomeownerLeadSubmissionResult = await submitHomeownerLead(input);

  if (result.status === "success") {
    return {
      error: null,
      success: true,
      message: result.message,
    };
  }

  return {
    error: result.message,
    success: false,
    message: null,
  };
}
