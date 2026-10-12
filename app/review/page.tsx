"use client";

/**
 * Lead review — sourcing mode. No calling: look at each prospect, judge it, move on.
 * Keyboard: 1 good · 2 maybe · 3 bad · S skip · U undo last · Enter open site · G/N/E/D/O/M/B/W/X chips
 * · / note · Esc leave the note. Verdicts teach the "learned" order and sync to GHL at the end.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Chip = { key: string; hotkey: string; label: string };
type Card = {
  id: number;
  phone: string;
  company: string;
  org_number: string | null;
  company_type: string | null;
  email: string | null;
  website: string | null;
  street: string | null;
  postcode: string | null;
  city: string | null;
  years: number | null;
  trades: string[];
  sni: string | null;
  sni_desc: string | null;
  presence: string;
  evidence: string | null;
  metro: string;
  alt_phone: string | null;
  description: string | null;
  v2: number;
  v2_reasons: string;
  sources: string;
  in_ghl: number;
  verdict: string | null;
  chips: string[];
  note: string | null;
  fit?: number | null;
  features: string[];
};
type Pattern = { feature: string; n: number; good: number; maybe: number; bad: number; goodRate: number; lift: number };
type State = {
  current: Card | null;
  upcoming: { id: number; company: string; city: string | null; v2: number; fit: number | null }[];
  last: Card | null;
  counts: { total: number; left: number; today: number; unsynced: number };
  sources: { source: string; n: number }[];
  chips: Chip[];
  model: {
    reviewed: number;
    good: number;
    maybe: number;
    bad: number;
    ready: boolean;
    top: Pattern[];
    bottom: Pattern[];
    chipStats: { chip: string; label: string; n: number; good: number; bad: number }[];
  };
  order: "v2" | "learned";
};
type SyncPlan = {
  pending: number;
  matchedSoFar: number;
  notInGhl: number;
  phoneMap: { contacts: number; oldest: string | null };
  quota: { remaining: number | null; resetAt: string | null } | null;
};

const GENERIC_MAIL = /@(gmail|hotmail|outlook|live|yahoo|icloud|telia|bredband|spray|msn|me)\./i;

function siteFromEmail(email: string | null, website: string | null): string | null {
  if (!email || GENERIC_MAIL.test(email)) return null;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  const host = (website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  return host === domain ? null : `https://${domain}`;
}

function titleCase(s: string | null) {
  return (s || "").toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
}

/** The verdict is about the PROSPECT, not the site: a bad website in the right niche is a good lead. */
const VERDICT_HINT: Record<string, string> = {
  good: "right niche, weak site",
  maybe: "unsure",
  bad: "wrong niche or site is fine",
};

const VERDICT_STYLE: Record<string, string> = {
  good: "bg-emerald-600 hover:bg-emerald-500",
  maybe: "bg-amber-600 hover:bg-amber-500",
  bad: "bg-rose-700 hover:bg-rose-600",
};

export default function ReviewPage() {
  const [st, setSt] = useState<State | null>(null);
  const [order, setOrder] = useState<"v2" | "learned">("v2");
  const [source, setSource] = useState("");
  const [ghl, setGhl] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [embeddable, setEmbeddable] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const startedAt = useRef(Date.now());

  const filters = useCallback(() => ({ order, source: source || undefined, ghl: ghl || undefined }), [order, source, ghl]);

  const apply = useCallback((s: State) => {
    setSt(s);
    setChips(s.current?.chips ?? []);
    setNote(s.current?.note ?? "");
    startedAt.current = Date.now();
  }, []);

  const load = useCallback(async () => {
    const q = new URLSearchParams(Object.entries(filters()).filter(([, v]) => v) as [string, string][]);
    const res = await fetch(`/api/review?${q}`, { cache: "no-store" });
    apply(await res.json());
  }, [filters, apply]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshPlan = useCallback(async () => {
    setPlan(await (await fetch("/api/review/sync", { cache: "no-store" })).json());
  }, []);
  useEffect(() => {
    refreshPlan();
  }, [refreshPlan, st?.counts.unsynced]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...filters(), ...body }),
        });
        const data = await res.json();
        if (data.error) setMsg(data.error);
        else apply(data);
      } finally {
        setBusy(false);
      }
    },
    [busy, filters, apply]
  );

  const cur = st?.current ?? null;
  const verdict = useCallback(
    (v: "good" | "maybe" | "bad") => cur && post({ action: "verdict", id: cur.id, verdict: v, chips, note }),
    [cur, chips, note, post]
  );
  const skip = useCallback(() => cur && post({ action: "skip", id: cur.id }), [cur, post]);
  const undo = useCallback(() => st?.last && post({ action: "undo", id: st.last.id }), [st?.last, post]);
  const toggleChip = useCallback((k: string) => setChips((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k])), []);

  const site = cur?.website || null;
  const altSite = cur ? siteFromEmail(cur.email, cur.website) : null;
  const openSite = useCallback(() => {
    const u = site || altSite;
    if (u) window.open(u, "_blank", "noopener");
  }, [site, altSite]);

  useEffect(() => {
    setEmbeddable(null);
    if (!site) return;
    let live = true;
    fetch(`/api/sitecheck?url=${encodeURIComponent(site)}`)
      .then((r) => r.json())
      .then((d) => live && setEmbeddable(Boolean(d.embeddable)))
      .catch(() => live && setEmbeddable(false));
    return () => {
      live = false;
    };
  }, [site]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = document.activeElement?.tagName === "TEXTAREA" || document.activeElement?.tagName === "INPUT";
      if (typing) {
        if (e.key === "Escape") (document.activeElement as HTMLElement).blur();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "1") verdict("good");
      else if (k === "2") verdict("maybe");
      else if (k === "3") verdict("bad");
      else if (k === "s") skip();
      else if (k === "u") undo();
      else if (k === "enter") openSite();
      else if (k === "/") {
        e.preventDefault();
        noteRef.current?.focus();
      } else {
        const chip = st?.chips.find((c) => c.hotkey === k);
        if (chip) toggleChip(chip.key);
        else return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [verdict, skip, undo, openSite, toggleChip, st?.chips]);

  const sync = async () => {
    setMsg("Syncing to GHL…");
    const r = await (await fetch("/api/review/sync", { method: "POST" })).json();
    if (r.error && !r.synced) setMsg(`Sync: ${r.error}`);
    else
      setMsg(
        `Synced ${r.synced}/${r.pending} (${r.writes} field writes, ${r.notes} notes)` +
          (r.notInGhl ? ` · ${r.notInGhl} not in GHL yet — use "Export new leads"` : "") +
          (r.stoppedOnQuota ? " · stopped: daily quota" : "")
      );
    load();
  };
  const rank = async () => {
    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...filters(), action: "rank" }),
    });
    const d = await res.json();
    if (d.error) return setMsg(d.error);
    apply(d);
    const r = d.ranked;
    setMsg(
      `Dialer feedback → ${r.calls.good} good, ${r.calls.bad} bad${r.calls.kept ? ` (${r.calls.kept} kept your /review verdict)` : ""}. ` +
        `Ranked ${r.ranked}${r.learned ? " with the learned pattern" : " (v2 only — need 8 good + 8 bad to learn)"}: ` +
        `${r.requeuedGood} good leads moved to the top of the dial queue, ${r.removedBad} bad ones taken out.`
    );
  };
  const exportNew = async () => {
    const r = await (await fetch("/api/review/export", { method: "POST" })).json();
    setMsg(r.rows ? `${r.rows} new leads → ${r.file}\nImport: ${r.command}\nThen Sync again to add the review tags.` : "No good/maybe leads outside GHL yet.");
  };

  const q = encodeURIComponent(`${cur?.company ?? ""} ${titleCase(cur?.city ?? "")}`);
  const pct = st ? Math.round(((st.counts.total - st.counts.left) / Math.max(1, st.counts.total)) * 100) : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-[family-name:var(--font-geist-sans)]">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2 text-sm">
        <a href="/" className="text-zinc-500 hover:text-zinc-300">← Dialer</a>
        <span className="font-semibold">Lead review</span>
        <span className="text-zinc-500">sourcing mode · no calls</span>
        <span className="ml-auto text-zinc-400">
          {st ? `${st.counts.total - st.counts.left}/${st.counts.total} reviewed (${pct}%) · ${st.counts.today} today` : "…"}
        </span>
        <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300">
          <option value="">all sources</option>
          {st?.sources.map((s) => (
            <option key={s.source} value={s.source}>{s.source} ({s.n})</option>
          ))}
        </select>
        <select value={ghl} onChange={(e) => setGhl(e.target.value)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300">
          <option value="">in GHL + new</option>
          <option value="in">already in GHL</option>
          <option value="out">not in GHL yet</option>
        </select>
        <select
          value={order}
          onChange={(e) => setOrder(e.target.value as "v2" | "learned")}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300"
          title="learned = ranked by what your good verdicts have in common (after 8 good + 8 bad)"
        >
          <option value="v2">order: priority v2</option>
          <option value="learned" disabled={!st?.model.ready}>order: learned from my reviews{st?.model.ready ? "" : " (need 8 good + 8 bad)"}</option>
        </select>
      </header>

      {msg && (
        <div className="whitespace-pre-wrap border-b border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300">
          {msg} <button onClick={() => setMsg(null)} className="ml-2 text-zinc-500 hover:text-zinc-300">✕</button>
        </div>
      )}

      <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 space-y-3">
          {!st ? (
            <p className="text-zinc-500">Loading…</p>
          ) : !cur ? (
            <div className="rounded border border-zinc-800 p-6 text-zinc-400">
              {st.counts.total ? "Nothing left to review with these filters. 🎉 Sync to GHL →" : "No prospects loaded — run `npm run review:import`."}
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h1 className="text-2xl font-semibold">{cur.company}</h1>
                  <span className="text-zinc-400">{titleCase(cur.city)}{cur.postcode ? ` · ${cur.postcode}` : ""}</span>
                  <span className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-sm">
                    v2 <b>{cur.v2}</b>
                    {cur.fit != null && <> · fit <b>{Math.round(cur.fit * 100)}%</b></>}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-sm">
                  <span className="rounded bg-zinc-800 px-2 py-0.5">{cur.years != null ? `${Math.floor(cur.years)} years` : "age unknown"}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5">{cur.trades.length ? cur.trades.join(", ") : cur.sni_desc || "trade unknown"}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5">{cur.company_type === "EF" ? "sole trader (NIX)" : cur.company_type || "company"}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5">site: {cur.presence}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5">{cur.metro || "small town"}</span>
                  <span className={`rounded px-2 py-0.5 ${cur.in_ghl ? "bg-sky-900/60 text-sky-200" : "bg-violet-900/60 text-violet-200"}`}>
                    {cur.in_ghl ? "in GHL" : "new"} · {cur.sources}
                  </span>
                </div>
                <p className="mt-2 text-sm text-zinc-400">{cur.v2_reasons}{cur.evidence && cur.evidence !== cur.v2_reasons ? ` · ${cur.evidence}` : ""}</p>
                {cur.description && <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{cur.description}</p>}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <span className="font-mono text-zinc-300">{cur.phone}{cur.alt_phone ? ` · ${cur.alt_phone}` : ""}</span>
                  {cur.email && <span className="text-zinc-400">{cur.email}</span>}
                  {cur.org_number && <span className="font-mono text-zinc-500">{cur.org_number}</span>}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-sm">
                  {site && <a href={site} target="_blank" rel="noopener" className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800">🌐 {site.replace(/^https?:\/\//, "")} ↗</a>}
                  {altSite && <a href={altSite} target="_blank" rel="noopener" className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800" title="domain from their email">✉️ {altSite.replace(/^https:\/\//, "")} ↗</a>}
                  <a href={`https://www.google.com/search?q=${q}`} target="_blank" rel="noopener" className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800">Google (GBP panel) ↗</a>
                  <a href={`https://www.google.com/maps/search/${q}`} target="_blank" rel="noopener" className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800">Maps ↗</a>
                  {cur.org_number && <a href={`https://www.allabolag.se/${cur.org_number}`} target="_blank" rel="noopener" className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800">Allabolag ↗</a>}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {st.chips.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => toggleChip(c.key)}
                    className={`rounded-full border px-3 py-1 text-sm ${chips.includes(c.key) ? "border-sky-400 bg-sky-900/50 text-sky-100" : "border-zinc-700 text-zinc-400 hover:bg-zinc-900"}`}
                  >
                    <kbd className="mr-1 text-zinc-500">{c.hotkey.toUpperCase()}</kbd>{c.label}
                  </button>
                ))}
              </div>
              <textarea
                ref={noteRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Note (/ to focus, Esc to leave) — synced to GHL as a contact note"
                className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm focus:border-zinc-600 focus:outline-none"
              />
              <div className="flex flex-wrap gap-2">
                {(["good", "maybe", "bad"] as const).map((v, i) => (
                  <button key={v} disabled={busy} onClick={() => verdict(v)} title={VERDICT_HINT[v]} className={`rounded px-5 py-2 font-medium text-white disabled:opacity-50 ${VERDICT_STYLE[v]}`}>
                    <kbd className="mr-1 opacity-70">{i + 1}</kbd>
                    <span className="capitalize">{v}</span>
                    <span className="ml-1.5 text-xs font-normal opacity-80">{VERDICT_HINT[v]}</span>
                  </button>
                ))}
                <button disabled={busy} onClick={skip} className="rounded border border-zinc-700 px-4 py-2 text-zinc-300 hover:bg-zinc-900"><kbd className="mr-1 text-zinc-500">S</kbd>skip</button>
                <button disabled={busy || !st.last} onClick={undo} className="rounded border border-zinc-700 px-4 py-2 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40" title={st.last ? `undo: ${st.last.company} (${st.last.verdict})` : ""}>
                  <kbd className="mr-1 text-zinc-500">U</kbd>undo{st.last ? ` ${st.last.company.slice(0, 24)}` : ""}
                </button>
                <span className="self-center text-xs text-zinc-500">Enter opens the site</span>
              </div>

              <div className="overflow-hidden rounded-lg border border-zinc-800 bg-white" style={{ height: "58vh" }}>
                {site && embeddable ? (
                  <iframe key={site} src={site} className="h-full w-full" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
                ) : (
                  <div className="flex h-full items-center justify-center bg-zinc-900 text-sm text-zinc-500">
                    {!site ? "No website on file." : embeddable === null ? "Checking site…" : "This site can't be shown inline — press Enter to open it in a tab."}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="space-y-4 text-sm">
          <div className="rounded-lg border border-zinc-800 p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Patterns</h2>
              <span className="text-zinc-500">
                {st ? `${st.model.good} good · ${st.model.maybe} maybe · ${st.model.bad} bad` : ""}
              </span>
            </div>
            {!st || st.model.reviewed < 5 ? (
              <p className="text-zinc-500">Review a few leads — the traits your good picks share show up here, and “learned” order unlocks at 8 good + 8 bad.</p>
            ) : (
              <>
                <p className="mb-1 text-xs uppercase tracking-wide text-emerald-400">Points to good</p>
                <PatternList rows={st.model.top.filter((p) => p.lift > 0)} />
                <p className="mb-1 mt-3 text-xs uppercase tracking-wide text-rose-400">Points to bad</p>
                <PatternList rows={st.model.bottom.filter((p) => p.lift < 0)} />
                {st.model.chipStats.length > 0 && (
                  <>
                    <p className="mb-1 mt-3 text-xs uppercase tracking-wide text-zinc-400">Your labels</p>
                    {st.model.chipStats.map((c) => (
                      <div key={c.chip} className="flex justify-between text-zinc-400">
                        <span>{c.label}</span>
                        <span>{c.n} · {c.good} good / {c.bad} bad</span>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 p-3">
            <h2 className="mb-2 font-semibold">Up next</h2>
            {st?.upcoming.map((u) => (
              <div key={u.id} className="flex justify-between gap-2 text-zinc-400">
                <span className="truncate">{u.company}</span>
                <span className="shrink-0 text-zinc-500">{titleCase(u.city)} · {u.v2}{u.fit != null ? ` · ${Math.round(u.fit * 100)}%` : ""}</span>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-zinc-800 p-3">
            <h2 className="mb-2 font-semibold">GHL</h2>
            <p className="text-zinc-400">
              {plan ? `${plan.pending} verdicts not synced` : "…"}
              {plan?.quota?.remaining != null && ` · quota ${plan.quota.remaining.toLocaleString()} left`}
              {plan?.quota?.resetAt && plan.quota.remaining === 0 && ` (resets ${new Date(plan.quota.resetAt).toLocaleTimeString()})`}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Sync tags review-good/maybe/bad + your labels, sets ICP Score (good → top of the dial queue, bad → bottom) and GBP Status. Leads not in GHL yet: export, import, then sync.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={rank} className="rounded bg-emerald-700 px-3 py-1.5 text-white hover:bg-emerald-600" title="pull verdicts from dialer wrapups, re-rank everything, reorder the dial queue (local, no GHL calls)">Apply to dial queue</button>
              <button onClick={sync} disabled={!plan?.pending} className="rounded bg-sky-700 px-3 py-1.5 text-white hover:bg-sky-600 disabled:opacity-40">Sync to GHL</button>
              <button onClick={exportNew} className="rounded border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-900">Export new leads</button>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function PatternList({ rows }: { rows: Pattern[] }) {
  if (!rows.length) return <p className="text-zinc-600">—</p>;
  return (
    <div className="space-y-0.5">
      {rows.map((p) => (
        <div key={p.feature} className="flex justify-between gap-2">
          <span className="truncate text-zinc-300">{p.feature}</span>
          <span className="shrink-0 text-zinc-500">
            {Math.round(p.goodRate * 100)}% good · n={p.n}
          </span>
        </div>
      ))}
    </div>
  );
}
