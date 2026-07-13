"use server";

import {
  createWebsiteIntakeLead,
  type IntakeAnswers,
} from "@/lib/intake";
import { createPublicClient } from "@/lib/supabase/public";

export type SubmitIntakeState = {
  error: string | null;
  success: boolean;
  leadId: string | null;
};

export async function submitWebsiteIntake(
  companyId: string,
  answers: IntakeAnswers,
): Promise<SubmitIntakeState> {
  if (!companyId) {
    return { error: "Company is missing.", success: false, leadId: null };
  }

  const supabase = createPublicClient();

  try {
    const leadId = await createWebsiteIntakeLead(supabase, companyId, answers);

    return { error: null, success: true, leadId };
  } catch (error) {
    if (error instanceof Error) {
      return { error: error.message, success: false, leadId: null };
    }

    return {
      error: "Unable to submit your request. Please try again.",
      success: false,
      leadId: null,
    };
  }
}
