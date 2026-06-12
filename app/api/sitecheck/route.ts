import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

declare global {
  // eslint-disable-next-line no-var
  var __sitecheckCache: Map<string, boolean> | undefined;
}

/** Can this website be shown in an iframe? (X-Frame-Options / CSP frame-ancestors check) */
export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url");
  if (!url || !/^https?:\/\//.test(url)) return NextResponse.json({ embeddable: false });

  const cache = (globalThis.__sitecheckCache ??= new Map());
  if (cache.has(url)) return NextResponse.json({ embeddable: cache.get(url) });

  let embeddable = false;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) coldcaller-sitecheck" },
    });
    const xfo = (res.headers.get("x-frame-options") || "").toLowerCase();
    const csp = (res.headers.get("content-security-policy") || "").toLowerCase();
    embeddable = res.ok && !xfo && !csp.includes("frame-ancestors");
  } catch {
    embeddable = false;
  }
  cache.set(url, embeddable);
  return NextResponse.json({ embeddable });
}
