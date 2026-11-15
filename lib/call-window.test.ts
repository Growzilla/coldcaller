import assert from "node:assert/strict";
import { test } from "node:test";
import { inCallWindow, leadClock, leadInCallWindow, leadTimeZone, openWindowLabel } from "./call-window";

/** 2026-11-10 06:00 UTC = 07:00 Stockholm, 14:00 Perth, 15:30 Darwin, 16:00 Brisbane, 17:00 Sydney. */
const NOV = new Date("2026-11-10T06:00:00Z");
/** 2026-06-10 06:00 UTC = 08:00 Stockholm (CEST), 14:00 Perth, 15:30 Adelaide, 16:00 Sydney (AEST). */
const JUN = new Date("2026-06-10T06:00:00Z");

test("state suffix, notes, and a bare capital each resolve", () => {
  assert.equal(leadTimeZone({ city: "Bunbury, WA", country: "Australia" }), "Australia/Perth");
  assert.equal(leadTimeZone({ city: "Perth", country: "Australia" }), "Australia/Perth");
  assert.equal(
    leadTimeZone({ city: "", country: "Australia", prior_notes: "AU WA · electrician" }),
    "Australia/Perth"
  );
  assert.equal(leadTimeZone({ city: "Sydney", country: "Australia" }), "Australia/Sydney");
  assert.equal(leadTimeZone({ city: "Melbourne, VIC", country: "Australia" }), "Australia/Melbourne");
  assert.equal(leadTimeZone({ city: "Broken Hill, NSW", country: "Australia" }), "Australia/Broken_Hill");
  assert.equal(leadTimeZone({ country: "Sweden", city: "Göteborg" }), "Europe/Stockholm");
  assert.equal(leadTimeZone({ city: "Newport", country: "Australia" }), null);
  assert.equal(leadTimeZone({ country: "Canada", city: "Calgary" }), null);
  assert.equal(
    leadTimeZone({ country: "Canada", city: "Calgary", prior_notes: "CA America/Edmonton · Mountain · tier A" }),
    "America/Edmonton"
  );
  assert.equal(
    leadTimeZone({ country: "Canada", city: "Vancouver", prior_notes: "CA America/NotAZone · Pacific" }),
    null
  );
});

test("a Canada note follows that zone's clock", () => {
  const morningEast = new Date("2026-11-13T15:00:00Z");
  assert.equal(
    leadInCallWindow({ country: "Canada", city: "Toronto", prior_notes: "CA America/Toronto · Eastern" }, morningEast),
    true
  );
  assert.equal(
    leadInCallWindow({ country: "Canada", city: "Vancouver", prior_notes: "CA America/Vancouver · Pacific" }, morningEast),
    false
  );
  assert.match(openWindowLabel("Canada", morningEast), /Toronto 10:00/);
});

test("07:00 Stockholm calls Perth and Darwin, not the east coast or home", () => {
  assert.equal(leadInCallWindow({ city: "Kalgoorlie, WA", country: "Australia" }, NOV), true);
  assert.equal(leadInCallWindow({ city: "Darwin, NT", country: "Australia" }, NOV), true);
  assert.equal(leadInCallWindow({ city: "Brisbane, QLD", country: "Australia" }, NOV), false);
  assert.equal(leadInCallWindow({ city: "Sydney, NSW", country: "Australia" }, NOV), false);
  assert.equal(leadInCallWindow({ city: "Adelaide, SA", country: "Australia" }, NOV), false);
  assert.equal(leadInCallWindow({ country: "Sweden", city: "Stockholm" }, NOV), false);
  assert.equal(inCallWindow("Australia/Perth", NOV), true);
  assert.equal(inCallWindow(null, NOV), false);
});

test("June uses standard time, not the November offsets", () => {
  assert.equal(inCallWindow("Australia/Perth", JUN), true);
  assert.equal(inCallWindow("Australia/Adelaide", JUN), true);
  assert.equal(inCallWindow("Australia/Sydney", JUN), false);
  assert.equal(inCallWindow("Europe/Stockholm", JUN), false);
});

test("the window label names the open zones", () => {
  assert.equal(openWindowLabel("Australia", NOV), "Perth 14:00 · Darwin 15:30");
  assert.equal(openWindowLabel("Sweden", NOV), "");
  assert.match(leadClock({ city: "Perth, WA", country: "Australia" }, NOV) ?? "", /^Perth 14:00$/);
});
