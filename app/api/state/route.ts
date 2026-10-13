import { NextResponse } from "next/server";
import { activeSession, activeCall, nextLead, queuePreview, queueCounts, countryBreakdown, sourceBreakdown } from "@/lib/db";
import { callerIdForCountry, callerRegionForCountry, ELKS_CALLER_ID, config } from "@/lib/config";
import { assertDialerReady, getCallerIdOverride, getDialerProvider, getOperatorPhone, getProviderBalance } from "@/lib/dialer";

export const dynamic = "force-dynamic";

declare global {
  // eslint-disable-next-line no-var
  var __balanceCache: { value: { amount: number; currency: string } | null; at: number; provider?: string } | undefined;
}

async function getBalance() {
  const provider = getDialerProvider();
  const cache = globalThis.__balanceCache;
  if (cache && cache.provider === provider && Date.now() - cache.at < 5 * 60 * 1000) return cache.value;
  const value = await getProviderBalance();
  globalThis.__balanceCache = { value, at: Date.now(), provider };
  return value;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const country = params.get("country") || null;
  const source = params.get("source") || null;
  void import("@/lib/calendly").then((m) => m.checkBookings());
  const provider = getDialerProvider();
  const override = getCallerIdOverride();
  const lead = nextLead(country, source) ?? null;
  const callerId =
    provider === "46elks"
      ? ELKS_CALLER_ID
      : callerIdForCountry(lead?.country ?? country, override, "vonage");
  const callerRegion = provider === "46elks" ? "SE" : override ?? callerRegionForCountry(lead?.country ?? country);
  const bal = await getBalance();
  return NextResponse.json({
    ready: assertDialerReady(),
    provider,
    callerId,
    callerRegion,
    callerOverride: override,
    operatorPhone: getOperatorPhone() || null,
    session: activeSession() ?? null,
    call: activeCall() ?? null,
    currentLead: lead,
    queue: queuePreview(country, source),
    counts: queueCounts(country, source),
    countries: countryBreakdown(),
    sources: sourceBreakdown(),
    balance: bal?.amount ?? null,
    balanceCurrency: bal?.currency ?? "EUR",
  });
}