import assert from "node:assert/strict";
import { test } from "node:test";
import { leadFitsTwilioLine, normalizeTwilioNumber } from "./config";

test("parenthesized Australian Twilio number becomes E.164", () => {
  assert.equal(normalizeTwilioNumber("+61(485)068174"), "+61485068174");
  assert.equal(normalizeTwilioNumber("+18254757359"), "+18254757359");
  assert.equal(normalizeTwilioNumber(""), "");
});

test("Australia line accepts +61 and refuses a mis-tagged foreign number", () => {
  assert.equal(leadFitsTwilioLine({ country: "Australia", phone_e164: "+61407872550" }, "AU"), null);
  assert.match(
    leadFitsTwilioLine({ company: "Wrong tag", country: "Australia", phone_e164: "+491511234567" }, "AU") || "",
    /Australian/
  );
  assert.match(
    leadFitsTwilioLine({ company: "Calgary Co", country: "Canada", phone_e164: "+14035551212" }, "AU") || "",
    /Australia/
  );
});

test("Canada line accepts Canada leads and refuses Australia and the US", () => {
  assert.equal(leadFitsTwilioLine({ country: "Canada", phone_e164: "+14035551212" }, "CA"), null);
  assert.match(
    leadFitsTwilioLine({ company: "Mustart", country: "Australia", phone_e164: "+61407872550" }, "CA") || "",
    /Canadian/
  );
  assert.match(
    leadFitsTwilioLine({ company: "US Shop", country: "United States", phone_e164: "+12125551212" }, "CA") || "",
    /Canadian/
  );
});

test("manual and test dials follow the line, and the operator's own number is allowed", () => {
  assert.equal(leadFitsTwilioLine({ source_file: "test", country: null, phone_e164: "+46725597280" }, "AU"), null);
  assert.equal(leadFitsTwilioLine({ source_file: "manual", phone_e164: "+61400000000" }, "AU"), null);
  assert.match(leadFitsTwilioLine({ source_file: "manual", phone_e164: "+46701234567" }, "AU") || "", /\+61/);
  assert.equal(leadFitsTwilioLine({ source_file: "manual", phone_e164: "+14035551212" }, "CA"), null);
  const prev = globalThis.__operatorPhone;
  globalThis.__operatorPhone = "+46725597280";
  try {
    assert.equal(
      leadFitsTwilioLine({ source_file: "manual", country: "Sweden", phone_e164: "+46725597280" }, "AU"),
      null
    );
    assert.equal(
      leadFitsTwilioLine({ source_file: "manual", country: "Sweden", phone_e164: "+46725597280" }, "CA"),
      null
    );
  } finally {
    globalThis.__operatorPhone = prev;
  }
});
