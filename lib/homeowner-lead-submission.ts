import { createActivity } from "@/lib/activity";
import {
  createWebsiteIntakeLead,
  type IntakeAnswers,
} from "@/lib/intake";
import {
  qualifyHomeownerLeadSubmission,
  type HomeownerLeadSubmissionInput,
  type HomeownerQualificationResult,
} from "@/lib/homeowner-lead-qualification";
import { notifyEmployeesOfWebsiteLead } from "@/lib/employee-lead-notifications";
import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";

export type HomeownerLeadSubmissionResult =
  | { status: "success"; message: string }
  | { status: "validation_error"; message: string }
  | { status: "qualification_error"; message: string }
  | { status: "error"; message: string };

type HomeownerLeadSubmissionRuntime = {
  createClient: typeof createServiceClient;
  createLead: typeof createWebsiteIntakeLead;
  notifyEmployees: typeof notifyEmployeesOfWebsiteLead;
  logQualificationActivity: (
    supabase: SupabaseClient,
    input: {
      companyId: string;
      leadId: string;
      qualification: HomeownerQualificationResult;
    },
  ) => Promise<void>;
};

let homeownerLeadSubmissionRuntimeOverride: Partial<HomeownerLeadSubmissionRuntime> | null =
  null;

export function __setHomeownerLeadSubmissionRuntimeForTests(
  override: Partial<HomeownerLeadSubmissionRuntime> | null,
): void {
  homeownerLeadSubmissionRuntimeOverride = override;
}

function getHomeownerLeadSubmissionRuntime(): HomeownerLeadSubmissionRuntime {
  return {
    createClient:
      homeownerLeadSubmissionRuntimeOverride?.createClient ?? createServiceClient,
    createLead:
      homeownerLeadSubmissionRuntimeOverride?.createLead ?? createWebsiteIntakeLead,
    notifyEmployees:
      homeownerLeadSubmissionRuntimeOverride?.notifyEmployees ??
      notifyEmployeesOfWebsiteLead,
    logQualificationActivity:
      homeownerLeadSubmissionRuntimeOverride?.logQualificationActivity ??
      logHomeownerQualificationActivity,
  };
}

async function logHomeownerQualificationActivity(
  supabase: SupabaseClient,
  input: {
    companyId: string;
    leadId: string;
    qualification: HomeownerQualificationResult;
  },
): Promise<void> {
  if (input.qualification.status !== "qualified") {
    return;
  }

  try {
    await createActivity(supabase, {
      companyId: input.companyId,
      leadId: input.leadId,
      activityType: "website_lead_captured",
      summary: "Homeowner landing lead qualified",
      metadata: {
        qualification_status: input.qualification.status,
        source: "homeowner_landing",
      },
    });
  } catch (error) {
    console.error("Failed to record homeowner qualification activity:", error);
  }
}

export function normalizeHomeownerSubmissionInput(
  input: HomeownerLeadSubmissionInput,
): IntakeAnswers {
  return {
    full_name: input.full_name.trim(),
    phone: input.phone.trim(),
    email: input.email.trim(),
    address_line_1: input.address_line_1.trim(),
    city: input.city.trim(),
    state: input.state.trim(),
    postal_code: input.postal_code.trim(),
    project_type: input.project_type,
    storm_damage_details: input.storm_damage_details.trim(),
    description: input.description.trim(),
    insurance_claim: input.insurance_claim ?? false,
    adjuster_contacted: input.adjuster_contacted,
    urgency: input.urgency,
    preferred_contact: input.preferred_contact.trim(),
  };
}

export async function submitHomeownerLead(
  input: HomeownerLeadSubmissionInput,
): Promise<HomeownerLeadSubmissionResult> {
  const qualification = qualifyHomeownerLeadSubmission(input);

  if (qualification.status !== "qualified") {
    return {
      status: "qualification_error",
      message: qualification.reason,
    };
  }

  const runtime = getHomeownerLeadSubmissionRuntime();
  const supabase = runtime.createClient();

  if (!supabase) {
    return {
      status: "error",
      message: "Lead routing is temporarily unavailable. Please try again later.",
    };
  }

  const companyId = qualification.companyId;

  const answers = normalizeHomeownerSubmissionInput(input);

  let leadId: string;

  try {
    leadId = await runtime.createLead(
      supabase,
      companyId,
      answers,
    );
  } catch (error) {
    if (error instanceof Error) {
      return {
        status: "validation_error",
        message: error.message,
      };
    }

    return {
      status: "error",
      message: "Unable to submit your request. Please try again.",
    };
  }

  await runtime.logQualificationActivity(supabase, {
    companyId,
    leadId,
    qualification,
  });

  try {
    await runtime.notifyEmployees({
      companyId,
      leadId,
      answers,
    });
  } catch (error) {
    console.error("Homeowner website lead notification failed:", error);
  }

  return {
    status: "success",
    message:
      "Thanks — your request was received. A roofing professional will contact you soon.",
  };
}
