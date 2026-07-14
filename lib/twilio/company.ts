import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function phoneMatchKeys(phone: string): Set<string> {
  const digits = phone.replace(/\D/g, "");
  const keys = new Set<string>();

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

export function phonesMatch(phoneA: string, phoneB: string): boolean {
  const keysA = phoneMatchKeys(phoneA);
  const keysB = phoneMatchKeys(phoneB);

  for (const key of keysA) {
    if (keysB.has(key)) {
      return true;
    }
  }

  return false;
}

type CompanyPhoneRecord = {
  id: string;
  business_phone: string | null;
};

async function loadCompaniesWithPhones(
  supabase: SupabaseClient,
): Promise<CompanyPhoneRecord[]> {
  const { data, error } = await supabase
    .from("companies")
    .select("id, business_phone");

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function companyExists(
  supabase: SupabaseClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data?.id);
}

function matchCompanyByPhone(
  companies: CompanyPhoneRecord[],
  calledPhone: string,
): string | null {
  for (const company of companies) {
    if (
      company.business_phone &&
      phonesMatch(company.business_phone, calledPhone)
    ) {
      return company.id;
    }
  }

  return null;
}

function getConfiguredTwilioPhone(): string | null {
  return process.env.TWILIO_PHONE_NUMBER?.trim() ?? null;
}

function getConfiguredDefaultCompanyId(): string | null {
  return process.env.TWILIO_DEFAULT_COMPANY_ID?.trim() ?? null;
}

async function resolveConfiguredDefaultCompany(
  supabase: SupabaseClient,
  calledPhone: string,
): Promise<string | null> {
  const defaultCompanyId = getConfiguredDefaultCompanyId();

  if (!defaultCompanyId) {
    return null;
  }

  const configuredTwilioPhone = getConfiguredTwilioPhone();

  if (
    configuredTwilioPhone &&
    calledPhone &&
    !phonesMatch(configuredTwilioPhone, calledPhone)
  ) {
    return null;
  }

  if (!(await companyExists(supabase, defaultCompanyId))) {
    console.error(
      "TWILIO_DEFAULT_COMPANY_ID is set but does not match an existing company.",
    );
    return null;
  }

  return defaultCompanyId;
}

function resolveSingleCompanyFallback(
  companies: CompanyPhoneRecord[],
): string | null {
  if (companies.length !== 1) {
    return null;
  }

  return companies[0]?.id ?? null;
}

export async function lookupCompanyIdByCalledPhone(
  supabase: SupabaseClient,
  calledPhone: string,
): Promise<string | null> {
  const companies = await loadCompaniesWithPhones(supabase);
  const trimmedCalledPhone = calledPhone.trim();

  if (trimmedCalledPhone) {
    const matchedCompanyId = matchCompanyByPhone(
      companies,
      trimmedCalledPhone,
    );

    if (matchedCompanyId) {
      return matchedCompanyId;
    }
  }

  const configuredCompanyId = await resolveConfiguredDefaultCompany(
    supabase,
    trimmedCalledPhone,
  );

  if (configuredCompanyId) {
    return configuredCompanyId;
  }

  return resolveSingleCompanyFallback(companies);
}

export async function resolveCompanyForTwilioCall(
  calledPhone: string,
): Promise<string | null> {
  const supabase = createServiceClient();

  if (!supabase) {
    console.error(
      "Twilio company lookup failed: SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL is not configured.",
    );
    return null;
  }

  try {
    const companyId = await lookupCompanyIdByCalledPhone(
      supabase,
      calledPhone,
    );

    if (!companyId) {
      console.error(
        "Twilio company lookup failed: no company matched called phone.",
        JSON.stringify({ calledPhone: normalizePhone(calledPhone) || "missing" }),
      );
    }

    return companyId;
  } catch (error) {
    console.error("Twilio company lookup failed:", error);
    return null;
  }
}
