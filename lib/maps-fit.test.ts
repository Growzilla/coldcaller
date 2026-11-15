import assert from "node:assert/strict";
import test from "node:test";
import { decideFit, fold, isBigCity, matchPlace, packQuery, tradesOf, type Pack } from "./maps-fit";

test("fold strips Swedish vowels and legal noise", () => {
  assert.equal(fold("Skogqvist Elteknik AB"), "skogqvist elteknik ab");
  assert.equal(fold("Göteborg"), "goteborg");
  assert.equal(fold("Fredrik Åhlén"), "fredrik ahlen");
});

test("trade words and cities", () => {
  assert.deepEqual(tradesOf("electrician, solar"), ["electrician", "solar"]);
  assert.deepEqual(tradesOf("Electrician, electrician"), ["electrician"]);
  assert.deepEqual(tradesOf("apparel & fashion"), []);
  assert.equal(packQuery("electrician", "Falun", "SE"), "elektriker Falun");
  assert.equal(packQuery("electrician", "Melbourne, VIC", "AU"), "electrician Melbourne");
  assert.equal(packQuery("electrician", "Falun", "OTHER"), null);
  assert.equal(isBigCity("Stockholm"), true);
  assert.equal(isBigCity("Göteborg"), true);
  assert.equal(isBigCity("Falun"), false);
  assert.equal(isBigCity("Råneå"), false);
  assert.equal(isBigCity("Täby"), true);
});

test("name match is strict about who is on the screen", () => {
  assert.equal(matchPlace("Skogqvist Elteknik AB", "Skogqvist Elteknik", "Råneå"), "same");
  assert.equal(matchPlace("Sennans El AB", "Sennans Elektriska", "Halmstad"), "same");
  assert.equal(matchPlace("Fredrik Åhlén AB", "Fredrik Åhlén", "Stockholm"), "same");
  assert.equal(matchPlace("Fredrik Åhlén AB", "Fredrik Pettersson El", "Stockholm"), "different");
  assert.equal(matchPlace("Anderssons El AB", "Petterssons El", "Mora"), "different");
  assert.equal(matchPlace("Frithiof Svenssons Elektriska", "Frithiof Svenssons El", "Vallentuna"), "same");
  // One letter off on a long token is the same firm. A short prefix is only a maybe.
  assert.equal(matchPlace("Skogqvist Elteknik AB", "Skogqvists El", "Råneå"), "same");
  assert.equal(matchPlace("Åhlén El AB", "Åhléns El", "Stockholm"), "ambiguous");
  // A firm whose only word is a first name cannot be cleared against a similar listing.
  assert.equal(matchPlace("Anders El", "Anders Elektriska", "Mora"), "ambiguous");
  // A generic listing does not implicate a firm that has its own name.
  assert.equal(matchPlace("Skogqvist Elteknik AB", "El i Råneå", "Råneå"), "different");
  // Nothing distinctive on the lead itself: we cannot prove it is absent.
  assert.equal(matchPlace("El AB", "Skogqvist Elteknik", "Falun"), "ambiguous");
});

function pack(trade: string, query: string, names: string[], complete = true): Pack {
  return { trade, query, complete, names };
}

test("a complete small-town pack that misses them is suitable", () => {
  const d = decideFit({
    company: "Skogqvist Elteknik AB",
    city: "Råneå",
    region: "SE",
    trades: ["electrician"],
    packs: [pack("electrician", "elektriker Råneå", ["Någon Annan El", "Luleå Eltjänst"])],
    gbp: "none",
  });
  assert.equal(d.fit, "suitable");
  assert.equal(d.gbp, "none");
  assert.match(d.reason, /elektriker Råneå/);
  assert.match(d.reason, /no Business Profile/);
  assert.equal(d.rank, 0);
});

test("being the firm on the screen is never suitable", () => {
  const d = decideFit({
    company: "Skogqvist Elteknik AB",
    city: "Råneå",
    region: "SE",
    trades: ["electrician"],
    packs: [pack("electrician", "elektriker Råneå", ["Skogqvist Elteknik"])],
    gbp: "none",
  });
  assert.equal(d.fit, "shown");
  assert.equal(d.gbp, "present");
});

test("a maybe-match stays out even when the profile lookup says none", () => {
  const d = decideFit({
    company: "Åhlén El AB",
    city: "Falun",
    region: "SE",
    trades: ["electrician"],
    packs: [pack("electrician", "elektriker Falun", ["Åhléns El"])],
    gbp: "none",
  });
  assert.equal(d.fit, "ambiguous");
});

test("a capped city is suitable only with no Business Profile", () => {
  const names = Array.from({ length: 20 }, (_, i) => `Firma ${i} El`);
  const crowded = decideFit({
    company: "Fredrik Åhlén AB",
    city: "Stockholm",
    region: "SE",
    trades: ["electrician"],
    packs: [pack("electrician", "elektriker Stockholm", names, false)],
    gbp: "present",
  });
  assert.equal(crowded.fit, "unproven");
  const invisible = decideFit({
    company: "Fredrik Åhlén AB",
    city: "Stockholm",
    region: "SE",
    trades: ["electrician"],
    packs: [pack("electrician", "elektriker Stockholm", names, false)],
    gbp: "none",
  });
  assert.equal(invisible.fit, "suitable");
  assert.ok(invisible.rank > decideFit({
    company: "Skogqvist Elteknik AB",
    city: "Råneå",
    region: "SE",
    trades: ["electrician"],
    packs: [pack("electrician", "elektriker Råneå", ["Annan El"])],
    gbp: "none",
  }).rank);
});

test("a profile that does not rank in a complete pack is still suitable, behind no-profile leads", () => {
  const ranked = decideFit({
    company: "Lindqvist El AB",
    city: "Braås",
    region: "SE",
    trades: ["electrician"],
    packs: [pack("electrician", "elektriker Braås", ["Grannens El"])],
    gbp: "present",
  });
  assert.equal(ranked.fit, "suitable");
  assert.match(ranked.reason, /does not rank/);
  assert.ok(ranked.rank > 0);
});

test("a generic name is not cleared by an empty profile search", () => {
  const d = decideFit({
    company: "El AB",
    city: "Stockholm",
    region: "SE",
    trades: ["electrician"],
    packs: [pack("electrician", "elektriker Stockholm", [], false)],
    gbp: "none",
  });
  assert.equal(d.fit, "unproven");
});

test("unchecked, no city, and non-trades do not pass", () => {
  assert.equal(decideFit({
    company: "X", city: "Falun", region: "SE", trades: ["electrician"], packs: [], gbp: "none",
  }).fit, "pending");
  assert.equal(decideFit({
    company: "X", city: "", region: "SE", trades: ["electrician"], packs: [], gbp: null,
  }).fit, "no_city");
  assert.equal(decideFit({
    company: "Shop", city: "Falun", region: "SE", trades: [], packs: [], gbp: null,
  }).fit, "not_trade");
  assert.equal(decideFit({
    company: "X", city: "Calgary", region: "OTHER", trades: ["electrician"], packs: [], gbp: "none",
  }).fit, "unproven");
});

test("every trade has to miss them", () => {
  const d = decideFit({
    company: "Solcellsgruppen AB",
    city: "Mora",
    region: "SE",
    trades: ["electrician", "solar"],
    packs: [
      pack("electrician", "elektriker Mora", ["Annan El"]),
      pack("solar", "solceller Mora", ["Solcellsgruppen"]),
    ],
    gbp: "none",
  });
  assert.equal(d.fit, "shown");
});
