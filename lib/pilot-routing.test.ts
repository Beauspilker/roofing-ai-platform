import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  isPostalCodeInPilotTerritory,
  normalizePostalCode,
  resolvePilotCompanyRoute,
} from "./pilot-routing.js";

const PILOT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  delete process.env.PILOT_COMPANY_ID;
  delete process.env.PILOT_ZIP_PREFIXES;
});

afterEach(() => {
  delete process.env.PILOT_COMPANY_ID;
  delete process.env.PILOT_ZIP_PREFIXES;
});

test("normalizePostalCode strips non-digits and limits to 5", () => {
  assert.equal(normalizePostalCode("68310-1234"), "68310");
  assert.equal(normalizePostalCode("68 310"), "68310");
});

test("isPostalCodeInPilotTerritory allows all zips when no prefixes configured", () => {
  assert.equal(isPostalCodeInPilotTerritory("68310", []), true);
});

test("isPostalCodeInPilotTerritory matches configured prefixes", () => {
  assert.equal(isPostalCodeInPilotTerritory("68310", ["683"]), true);
  assert.equal(isPostalCodeInPilotTerritory("90210", ["683"]), false);
});

test("resolvePilotCompanyRoute returns misconfigured when company id missing", () => {
  const result = resolvePilotCompanyRoute({
    postalCode: "68310",
    pilotCompanyId: "",
  });

  assert.equal(result.status, "misconfigured");
});

test("resolvePilotCompanyRoute returns outside_territory for unmatched zip", () => {
  const result = resolvePilotCompanyRoute({
    postalCode: "90210",
    pilotCompanyId: PILOT_ID,
    zipPrefixes: "683,684",
  });

  assert.equal(result.status, "outside_territory");
});

test("resolvePilotCompanyRoute routes to configured pilot company", () => {
  const result = resolvePilotCompanyRoute({
    postalCode: "68310",
    pilotCompanyId: PILOT_ID,
    zipPrefixes: "683",
  });

  assert.deepEqual(result, { status: "routed", companyId: PILOT_ID });
});
