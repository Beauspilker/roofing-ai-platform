import { isValidCompanyId } from "@/lib/intake";

export type PilotRoutingResult =
  | { status: "routed"; companyId: string }
  | { status: "misconfigured"; reason: string }
  | { status: "outside_territory"; reason: string };

function parseZipPrefixes(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizePostalCode(postalCode: string): string {
  return postalCode.replace(/\D/g, "").slice(0, 5);
}

export function isPostalCodeInPilotTerritory(
  postalCode: string,
  allowedPrefixes: string[],
): boolean {
  if (allowedPrefixes.length === 0) {
    return true;
  }

  const normalized = normalizePostalCode(postalCode);

  if (normalized.length < 5) {
    return false;
  }

  return allowedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function resolvePilotCompanyRoute(input: {
  postalCode: string;
  pilotCompanyId?: string | null;
  zipPrefixes?: string | null;
}): PilotRoutingResult {
  const companyId = input.pilotCompanyId?.trim() ?? "";

  if (!companyId) {
    return {
      status: "misconfigured",
      reason: "Pilot company routing is not configured.",
    };
  }

  if (!isValidCompanyId(companyId)) {
    return {
      status: "misconfigured",
      reason: "Pilot company routing is misconfigured.",
    };
  }

  const allowedPrefixes = parseZipPrefixes(input.zipPrefixes ?? undefined);

  if (!isPostalCodeInPilotTerritory(input.postalCode, allowedPrefixes)) {
    return {
      status: "outside_territory",
      reason: "This property is outside our current service area.",
    };
  }

  return { status: "routed", companyId };
}

export function resolvePilotCompanyRouteFromEnv(input: {
  postalCode: string;
}): PilotRoutingResult {
  return resolvePilotCompanyRoute({
    postalCode: input.postalCode,
    pilotCompanyId: process.env.PILOT_COMPANY_ID,
    zipPrefixes: process.env.PILOT_ZIP_PREFIXES,
  });
}
