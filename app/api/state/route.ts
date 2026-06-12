import { NextResponse } from "next/server";
import { activeSession, activeCall, nextLead, queuePreview, queueCounts, countryBreakdown, sourceBreakdown } from "@/lib/db";
import { config, assertCallReady, callerIdForCountry, callerRegionForCountry } from "@/lib/config";
import { getCallerIdOverride } from "@/lib/vonage";

export const dynamic = "force-dynamic";

declare global {
  // eslint-disable-next-line no-var
  var __balanceCache: { value: number | null; at: number } | undefined;
}

async function getBalance(): Promise<number | null> {
  const cache = globalThis.__balanceCache;
  if (cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.value;
  let value: number | null = null;
  try {
    if (config.vonageApiKey && config.vonageApiSecret) {
      const res = await fetch(
        `https://rest.nexmo.com/account/get-balance?api_key=${config.vonageApiKey}&api_secret=${encodeURIComponent(config.vonageApiSecret)}`,
        { cache: "no-store" }
      );
      if (res.ok) value = Number((await res.json()).value);
    }
  } catch {
    /* balance is cosmetic — never block on it */
  }
  globalThis.__balanceCache = { value, at: Date.now() };
  return value;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const country = params.get("country") || null;
  const source = params.get("source") || null;
  void import("@/lib/calendly").then((m) => m.checkBookings()); // dormant without CALENDLY_TOKEN
  const override = getCallerIdOverride();
  const lead = nextLead(country, source) ?? null;
  // Caller ID that the NEXT dial will actually use: manual override, else auto from
  // the next lead's country, else the selected country filter.
  const callerId = callerIdForCountry(lead?.country ?? country, override);
  const callerRegion = override ?? callerRegionForCountry(lead?.country ?? country);
  return NextResponse.json({
    ready: assertCallReady(),
    callerId,
    callerRegion,
    callerOverride: override,
    operatorPhone: config.operatorPhone || null,
    session: activeSession() ?? null,
    call: activeCall() ?? null,
    currentLead: lead,
    queue: queuePreview(country, source),
    counts: queueCounts(country, source),
    countries: countryBreakdown(),
    sources: sourceBreakdown(),
    balance: await getBalance(),
  });
}
