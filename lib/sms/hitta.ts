import { hittaSearchUrl, judgeListing, parseHittaHtml, swedishNumberKind, type ListingJudgement, type NumberKind } from "./logic";

export type HittaResult = ListingJudgement & {
  kind: NumberKind;
  hittaUrl: string;
  httpStatus: number | null;
};

let lastFetchAt = 0;

/** One public hitta.se search. Paced so a batch cannot hammer the directory. */
export async function lookupHitta(e164: string, leadName: string): Promise<HittaResult> {
  const kind = swedishNumberKind(e164);
  const hittaUrl = hittaSearchUrl(e164);
  if (kind !== "mobile") {
    const judged = judgeListing({ kind, parsed: { personNames: [], companyNames: [], exactNumberVisible: false }, leadName });
    return { ...judged, kind, hittaUrl, httpStatus: null };
  }

  const wait = 1500 - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();

  let html = "";
  let httpStatus: number | null = null;
  try {
    const res = await fetch(hittaUrl, {
      headers: {
        "accept": "text/html",
        "accept-language": "sv-SE,sv;q=0.9",
        "user-agent": "AnvilSmsValidate/1.0 (single-number directory check)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    httpStatus = res.status;
    html = await res.text();
    if (!res.ok) {
      return {
        kind,
        hittaUrl,
        httpStatus,
        ownerMatch: null,
        eligible: false,
        switchboard: false,
        ownerName: null,
        detail: `hitta.se returned HTTP ${res.status}. Number stays ineligible.`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "lookup failed";
    return {
      kind,
      hittaUrl,
      httpStatus,
      ownerMatch: null,
      eligible: false,
      switchboard: false,
      ownerName: null,
      detail: `hitta.se lookup failed (${message}). Number stays ineligible.`,
    };
  }

  const judged = judgeListing({ kind, parsed: parseHittaHtml(html, e164), leadName });
  return { ...judged, kind, hittaUrl, httpStatus };
}
