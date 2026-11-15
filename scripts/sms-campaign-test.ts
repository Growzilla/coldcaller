import assert from "node:assert/strict";
import fs from "fs";
import {
  classifyReply,
  clampDailyLimit,
  clampGap,
  fillTemplate,
  gapReady,
  insideSendWindow,
  judgeListing,
  matchesSegment,
  notificationText,
  parseHittaHtml,
  stockholmClock,
  swedishNumberKind,
} from "../lib/sms/logic";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`, err);
  }
}

check("mobile vs landline vs switchboard", () => {
  assert.equal(swedishNumberKind("+46701234567"), "mobile");
  assert.equal(swedishNumberKind("+46721234567"), "mobile");
  assert.equal(swedishNumberKind("+46731234567"), "mobile");
  assert.equal(swedishNumberKind("+46761234567"), "mobile");
  assert.equal(swedishNumberKind("+46791234567"), "mobile");
  assert.equal(swedishNumberKind("+4681234567"), "landline");
  assert.equal(swedishNumberKind("+46101234567"), "service");
  assert.equal(swedishNumberKind("+46201234567"), "service");
  assert.equal(swedishNumberKind("+46751234567"), "service");
  assert.equal(swedishNumberKind("+14155552671"), "foreign");
});

check("hitta exact person match is eligible", () => {
  const html = `<a href="/anna+andersson/stockholm/person/abc"></a><h2>Anna Andersson</h2>070-111 22 33<h2>Sveriges mest sökta</h2><h2>Ignore Me</h2>`;
  const parsed = parseHittaHtml(html, "+46701112233");
  const judged = judgeListing({ kind: "mobile", parsed, leadName: "Anna Andersson" });
  assert.equal(parsed.exactNumberVisible, true);
  assert.equal(judged.eligible, true);
  assert.equal(judged.ownerName, "Anna Andersson");
  assert.equal(parsed.personNames.includes("Ignore Me"), false);
});

check("hitta company listing is not eligible", () => {
  const html = `<a href="/bolaget/stockholm/foretag/zz"></a><h2>Bolaget AB</h2>070-111 22 33`;
  const parsed = parseHittaHtml(html, "+46701112233");
  const judged = judgeListing({ kind: "mobile", parsed, leadName: "Anna Andersson" });
  assert.equal(judged.switchboard, true);
  assert.equal(judged.eligible, false);
});

check("masked hitta number is not enough", () => {
  const html = `<a href="/anna+andersson/stockholm/person/abc"></a><h2>Anna Andersson</h2>070-111 22`;
  const parsed = parseHittaHtml(html, "+46701112233");
  assert.equal(parsed.exactNumberVisible, false);
  const judged = judgeListing({ kind: "mobile", parsed, leadName: "Anna Andersson" });
  assert.equal(judged.eligible, false);
  assert.equal(judged.ownerMatch, null);
});

check("landline is never eligible", () => {
  const judged = judgeListing({
    kind: "landline",
    parsed: { personNames: ["Anna Andersson"], companyNames: [], exactNumberVisible: true },
    leadName: "Anna Andersson",
  });
  assert.equal(judged.eligible, false);
});

check("template and classifier", () => {
  const filled = fillTemplate("Hej {Namn} på {Företag}", { Namn: "Anna", Företag: "AB" });
  assert.equal(filled.text, "Hej Anna på AB");
  assert.deepEqual(filled.missing, []);
  assert.deepEqual(fillTemplate("Hej {Stad}", { Namn: "Anna" }).missing, ["Stad"]);
  assert.equal(classifyReply("STOP").classification, "opt_out");
  assert.equal(classifyReply("Avregistrera").classification, "opt_out");
  assert.equal(classifyReply("Sluta").classification, "opt_out");
  assert.equal(classifyReply("Ja gärna, berätta mer").classification, "positive");
  assert.equal(classifyReply("Nej tack").classification, "negative");
  assert.equal(classifyReply("Vad kostar det?").classification, "question");
  assert.equal(classifyReply("sluta inte, jag är intresserad").classification, "positive");
  assert.equal(classifyReply("vi hörs imorgon").classification, "other");
});

check("window, gap, segment, caps", () => {
  const thursday = new Date("2026-01-15T12:00:00.000Z");
  assert.equal(stockholmClock(thursday).hour, 13);
  assert.equal(insideSendWindow(thursday, "09:00", "17:00", true).ok, true);
  assert.equal(insideSendWindow(thursday, "14:00", "17:00", true).ok, false);
  const sunday = new Date("2026-01-18T12:00:00.000Z");
  assert.equal(insideSendWindow(sunday, "09:00", "17:00", true).ok, false);
  assert.equal(insideSendWindow(sunday, "09:00", "17:00", false).ok, true);
  assert.equal(gapReady(thursday, new Date(thursday.getTime() - 30_000).toISOString(), 90).ok, false);
  assert.equal(gapReady(thursday, new Date(thursday.getTime() - 120_000).toISOString(), 90).ok, true);
  assert.equal(matchesSegment({ city: "Malmö", extra: {} }, { match: "all", rules: [{ field: "city", op: "eq", value: "Malmo" }] }), true);
  assert.equal(matchesSegment({ city: "Uppsala", extra: {} }, { match: "all", rules: [{ field: "city", op: "eq", value: "Malmo" }] }), false);
  assert.equal(clampDailyLimit(5000), 100);
  assert.equal(clampGap(1), 45);
  assert.match(notificationText({ kind: "positive", name: "Anna", company: "AB", phone: "+4670", reply: "Ja", reason: "ja", url: "http://localhost:3100/sms/inbox/1" }), /POSITIVT Anna, AB/);
});

async function storeTests() {
  const dbPath = `/tmp/sms-campaign-test-${process.pid}.db`;
  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(dbPath + suffix, { force: true });
  process.env.DIALER_DB = dbPath;

  const { createContact, createCampaign, getContact, isSuppressed, listRecipients, recordInbound, setCampaignStatus, setContactState, validateContact } = await import("../lib/sms/store");
  const { runSmsTick } = await import("../lib/sms/tick");
  const when = new Date("2026-01-15T12:00:00.000Z");

  try {
    const blocked = createContact({ name: "Landline", company: "Växel AB", phone: "+4681234567" });
    await validateContact(blocked.id);
    const after = getContact(blocked.id);
    assert.equal(after?.eligible, 0);

    const owner = createContact({ name: "Anna Andersson", company: "Andersson Bygg", phone: "+46701112233", city: "Stockholm" });
    await validateContact(owner.id, { manual: true });
    assert.equal(getContact(owner.id)?.eligible, 1);

    const talking = createContact({ name: "Bo Berg", company: "Berg AB", phone: "+46702223344" });
    await validateContact(talking.id, { manual: true });
    setContactState(talking.id, "in_conversation");

    const second = createContact({ name: "Erik Ek", company: "Ek AB", phone: "+46704445566" });
    await validateContact(second.id, { manual: true });

    const campaign = createCampaign({
      name: "Test",
      template: "Hej {Namn} på {Företag}",
      dailyLimit: 40,
      windowStart: "09:00",
      windowEnd: "17:00",
    });
    setCampaignStatus(campaign.id, "running");
    const enrolled = listRecipients(campaign.id).map((r) => r.phone_e164);
    assert.deepEqual(enrolled, ["+46701112233", "+46704445566"]);

    let sends = 0;
    const first = await runSmsTick(when, async () => {
      sends += 1;
      return { id: "sms-test-1" };
    });
    assert.equal(first.action, "sent");
    assert.equal(sends, 1);
    assert.equal(getContact(owner.id)?.contact_state, "contacted");

    const paced = await runSmsTick(when, async () => {
      sends += 1;
      return { id: "sms-test-2" };
    });
    assert.equal(paced.action, "wait");
    assert.equal(sends, 1);

    const inbound = recordInbound({
      providerId: "in-1",
      phone: "+46701112233",
      body: "Ja gärna",
      classification: "positive",
      reason: "test",
    });
    assert.equal(inbound.created, true);
    assert.equal(getContact(owner.id)?.contact_state, "in_conversation");
    const again = recordInbound({
      providerId: "in-1",
      phone: "+46701112233",
      body: "Ja gärna",
      classification: "positive",
      reason: "test",
    });
    assert.equal(again.created, false);

    recordInbound({
      providerId: "in-2",
      phone: "+46703334455",
      body: "STOP",
      classification: "opt_out",
      reason: "opt-out",
    });
    assert.equal(isSuppressed("+46703334455"), true);
    assert.throws(() => createContact({ name: "Again", phone: "+46703334455" }));
    console.log("ok  enroll, pace, opt-out");
  } finally {
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(dbPath + suffix, { force: true });
  }
}

storeTests()
  .then(() => {
    if (failed) {
      console.error(`${failed} failed`);
      process.exit(1);
    }
    console.log("all passed");
  })
  .catch((err) => {
    console.error("FAIL store/worker", err);
    process.exit(1);
  });
