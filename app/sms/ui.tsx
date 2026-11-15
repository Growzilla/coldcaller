"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type Rule = { field: string; op: "eq" | "contains" | "neq"; value: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    window.location.href = "/sms/login";
    throw new Error("Sign in required");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

function Frame({ children }: { children: React.ReactNode }) {
  const links = [
    ["/", "Overview"],
    ["/campaigns", "Campaigns"],
    ["/inbox", "Inbox"],
    ["/positive", "Positive"],
    ["/leads", "Leads"],
    ["/settings", "Settings"],
  ];
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-[family-name:var(--font-geist-sans)]">
      <header className="flex items-center gap-5 border-b border-zinc-800 px-5 py-3 text-sm">
        <Link href="/sms" className="font-semibold tracking-tight">SMS</Link>
        <nav className="flex gap-4 text-zinc-400">
          {links.map(([href, label]) => (
            <Link key={href} href={`/sms${href === "/" ? "" : href}`} className="hover:text-zinc-100">
              {label}
            </Link>
          ))}
        </nav>
        <Link href="/" className="ml-auto text-zinc-500 hover:text-zinc-200">Dialer</Link>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
    </div>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api<T>(path).then(setData).catch((err) => setError(err.message));
  }, [path]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, reload, setError };
}

function ErrorNote({ error }: { error: string }) {
  if (!error) return null;
  return <p className="mb-4 rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-200">{error}</p>;
}

const pill: Record<string, string> = {
  running: "text-emerald-300 border-emerald-800",
  delivered: "text-emerald-300 border-emerald-800",
  positive: "text-amber-300 border-amber-800",
  paused: "text-amber-300 border-amber-800",
  failed: "text-red-300 border-red-900",
  opted_out: "text-red-300 border-red-900",
  draft: "text-zinc-400 border-zinc-700",
  pending: "text-zinc-400 border-zinc-700",
  sent: "text-zinc-200 border-zinc-600",
  replied: "text-sky-300 border-sky-900",
  in_conversation: "text-sky-300 border-sky-900",
};

function Pill({ value }: { value: string }) {
  return <span className={`rounded border px-1.5 py-0.5 text-xs ${pill[value] || "border-zinc-700 text-zinc-300"}`}>{value.replaceAll("_", " ")}</span>;
}

export function Dashboard() {
  const { data, error, reload } = useLoad<any>("/api/sms/dashboard");
  useEffect(() => {
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [reload]);
  if (!data) return <Frame><ErrorNote error={error} /><p className="text-zinc-500">Loading…</p></Frame>;
  const cards = [
    ["Sent today", data.today.sent],
    ["Delivered", data.today.delivered],
    ["Failed", data.today.failed],
    ["Replies", data.today.replies],
    ["Positive", data.today.positive],
    ["Opt-outs", data.today.optOuts],
  ];
  return (
    <Frame>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Today, {data.date}</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Cap {data.settings.dailyLimit} · at least {data.settings.minGapSeconds}s between sends · {data.settings.windowStart}–{data.settings.windowEnd} Stockholm
            {data.settings.weekdaysOnly ? " · weekdays" : ""}. Hard ceiling {data.hardCap}/day.
          </p>
        </div>
        <p className="font-mono text-xs text-zinc-500">{data.provider.configured ? `From ${data.provider.from}` : "46elks credentials missing"}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {cards.map(([label, n]) => (
          <div key={String(label)} className="rounded border border-zinc-800 px-3 py-3">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="mt-1 font-mono text-2xl">{n}</div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-zinc-500">
        {data.totals.contacts} leads · {data.totals.eligible} validated mobiles · {data.totals.suppressed} suppressed · {data.totals.running} campaigns running
      </p>
      <h2 className="mb-2 mt-8 text-sm font-medium text-zinc-300">Log</h2>
      <ul className="divide-y divide-zinc-900 rounded border border-zinc-800 font-mono text-xs">
        {(data.audit as { id: number; created_at: string; action: string; detail: string }[]).map((row) => (
          <li key={row.id} className="flex gap-3 px-3 py-2">
            <span className="text-zinc-600">{row.created_at.slice(11, 19)}</span>
            <span className="text-zinc-300">{row.action}</span>
            <span className="truncate text-zinc-500">{row.detail}</span>
          </li>
        ))}
        {!data.audit.length && <li className="px-3 py-4 text-zinc-500">No actions yet.</li>}
      </ul>
    </Frame>
  );
}

function SegmentFields({ rules, setRules }: { rules: Rule[]; setRules: (rules: Rule[]) => void }) {
  const fields = ["city", "company", "name", "title", "source", "country"];
  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-500">Segment. Empty means every eligible lead.</div>
      {rules.map((rule, i) => (
        <div key={i} className="flex gap-2">
          <select className={field} value={rule.field} onChange={(e) => setRules(rules.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)))}>
            {fields.map((f) => <option key={f}>{f}</option>)}
          </select>
          <select className={field} value={rule.op} onChange={(e) => setRules(rules.map((r, j) => (j === i ? { ...r, op: e.target.value as Rule["op"] } : r)))}>
            <option value="eq">is</option>
            <option value="contains">contains</option>
            <option value="neq">is not</option>
          </select>
          <input className={field} value={rule.value} onChange={(e) => setRules(rules.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
          <button type="button" className="text-xs text-zinc-500" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" className="text-xs text-zinc-400" onClick={() => setRules([...rules, { field: "city", op: "eq", value: "" }])}>Add filter</button>
    </div>
  );
}

const field = "rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const btn = "rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900 disabled:text-zinc-600";
const go = "rounded border border-emerald-800 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-950 disabled:border-zinc-800 disabled:text-zinc-600";

export function CampaignList() {
  const { data, error, reload, setError } = useLoad<{ campaigns: any[] }>("/api/sms/campaigns");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("Hej {Namn}, det är Albert på Anvil. Jag byggde en ny hemsida åt {Företag}. Vill du se den?");
  const [rules, setRules] = useState<Rule[]>([]);
  const [dailyLimit, setDailyLimit] = useState(40);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await api<{ campaign: { id: number } }>("/api/sms/campaigns", {
        method: "POST",
        body: JSON.stringify({ name, template, dailyLimit, segment: { match: "all", rules } }),
      });
      window.location.href = `/sms/campaigns/${res.campaign.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create");
    }
  }
  async function act(id: number, action: string) {
    try {
      await api(`/api/sms/campaigns/${id}/action`, { method: "POST", body: JSON.stringify({ action }) });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  }
  return (
    <Frame>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <button type="button" className={go} onClick={() => setOpen((v) => !v)}>New campaign</button>
      </div>
      <ErrorNote error={error} />
      {open && (
        <form onSubmit={create} className="mb-6 space-y-3 rounded border border-zinc-800 p-4">
          <input className={`${field} w-full`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <textarea className={`${field} w-full`} rows={4} value={template} onChange={(e) => setTemplate(e.target.value)} required />
          <p className="text-xs text-zinc-500">Variables: {"{Namn}"} {"{Företag}"} {"{Förnamn}"} {"{Stad}"} {"{Titel}"}. Unfilled variables are not sent.</p>
          <label className="block text-xs text-zinc-500">Daily limit
            <input className={`${field} ml-2 w-24`} type="number" min={1} max={100} value={dailyLimit} onChange={(e) => setDailyLimit(Number(e.target.value))} />
          </label>
          <SegmentFields rules={rules} setRules={setRules} />
          <button className={go} type="submit">Create draft</button>
        </form>
      )}
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500"><tr><th className="py-2">Name</th><th>Status</th><th>Sent</th><th>Delivered</th><th>Failed</th><th>Replies</th><th></th></tr></thead>
        <tbody>
          {(data?.campaigns ?? []).map((c) => (
            <tr key={c.id} className="border-t border-zinc-900">
              <td className="py-2"><Link className="hover:underline" href={`/sms/campaigns/${c.id}`}>{c.name}</Link></td>
              <td><Pill value={c.status} /></td>
              <td className="font-mono">{c.sent || 0}</td>
              <td className="font-mono">{c.delivered || 0}</td>
              <td className="font-mono">{c.failed || 0}</td>
              <td className="font-mono">{c.replied || 0}</td>
              <td className="space-x-2 text-right">
                {c.status === "draft" && <button type="button" className={go} onClick={() => act(c.id, "start")}>Start</button>}
                {c.status === "running" && <button type="button" className={btn} onClick={() => act(c.id, "pause")}>Pause</button>}
                {c.status === "paused" && <button type="button" className={go} onClick={() => act(c.id, "resume")}>Resume</button>}
                {(c.status === "running" || c.status === "paused" || c.status === "draft") && <button type="button" className={btn} onClick={() => act(c.id, "cancel")}>Cancel</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.campaigns.length && <p className="mt-6 text-sm text-zinc-500">No campaigns yet.</p>}
    </Frame>
  );
}

export function CampaignDetail({ id }: { id: string }) {
  const { data, error, reload, setError } = useLoad<any>(`/api/sms/campaigns/${id}`);
  async function act(action: string) {
    try {
      await api(`/api/sms/campaigns/${id}/action`, { method: "POST", body: JSON.stringify({ action }) });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  }
  if (!data) return <Frame><ErrorNote error={error} /><p className="text-zinc-500">Loading…</p></Frame>;
  const c = data.campaign;
  return (
    <Frame>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
          <p className="mt-1 text-sm text-zinc-400">{c.daily_limit}/day · {c.window_start}–{c.window_end} · gap {c.min_gap_seconds}s · {c.weekdays_only ? "weekdays" : "all days"} · {c.exclude_contacted ? "skip already contacted" : "include already contacted"}</p>
        </div>
        <div className="flex gap-2">
          <Pill value={c.status} />
          {c.status === "draft" && <button type="button" className={go} onClick={() => act("start")}>Start</button>}
          {c.status === "running" && <button type="button" className={btn} onClick={() => act("pause")}>Pause</button>}
          {c.status === "paused" && <button type="button" className={go} onClick={() => act("resume")}>Resume</button>}
          {c.status !== "cancelled" && c.status !== "completed" && <button type="button" className={btn} onClick={() => act("cancel")}>Cancel</button>}
        </div>
      </div>
      <ErrorNote error={error} />
      <pre className="whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300">{c.template}</pre>
      <h2 className="mb-2 mt-6 text-sm text-zinc-400">Recipients</h2>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500"><tr><th className="py-2">Lead</th><th>Phone</th><th>Status</th><th>Note</th></tr></thead>
        <tbody>
          {data.recipients.map((r: any) => (
            <tr key={r.id} className="border-t border-zinc-900">
              <td className="py-2">{r.name || "—"} <span className="text-zinc-500">{r.company}</span></td>
              <td className="font-mono text-xs">{r.phone_e164}</td>
              <td><Pill value={r.status} /></td>
              <td className="text-xs text-zinc-500">{r.skip_reason || r.error || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!data.recipients.length && <p className="mt-3 text-sm text-zinc-500">Nobody enrolled yet. Start enrolls validated mobiles that match the segment and are not already in a conversation.</p>}
    </Frame>
  );
}

function CallLinks({ phone }: { phone: string }) {
  const dial = `/?provider=46elks&dial=${encodeURIComponent(phone)}`;
  return (
    <span className="space-x-2">
      <a className="text-emerald-300 hover:underline" href={dial}>Dial</a>
      <a className="text-zinc-400 hover:underline" href={`tel:${phone}`}>tel</a>
    </span>
  );
}

export function Leads() {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [path, setPath] = useState("/api/sms/contacts");
  const { data, error, reload, setError } = useLoad<{ rows: any[]; total: number }>(path);
  const [form, setForm] = useState({ name: "", company: "", phone: "", city: "" });
  function search(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (state) params.set("state", state);
    setPath(`/api/sms/contacts?${params.toString()}`);
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/sms/contacts", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", company: "", phone: "", city: "" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add");
    }
  }
  async function upload(file: File) {
    try {
      const result = await api<any>("/api/sms/contacts/import", { method: "POST", body: await file.text(), headers: { "content-type": "text/csv" } });
      setError("");
      alert(`Imported ${result.imported}. Duplicates ${result.duplicates}. Bad numbers ${result.invalidPhone}. Suppressed ${result.suppressed}.`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  }
  async function validate(id: number, manual = false, force = false) {
    try {
      await api(`/api/sms/contacts/${id}/validate`, { method: "POST", body: JSON.stringify({ manual, force }) });
      reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Validation failed";
      if (!manual && /company number/.test(message)) return;
      setError(message);
    }
  }
  async function mark(id: number, contactState: string) {
    try {
      await api(`/api/sms/contacts/${id}`, { method: "PATCH", body: JSON.stringify({ contactState }) });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update");
    }
  }
  return (
    <Frame>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
        <a className={btn} href={`/api/sms/contacts/export${path.includes("?") ? path.slice(path.indexOf("?")) : ""}`}>Export</a>
      </div>
      <ErrorNote error={error} />
      <form onSubmit={search} className="mb-4 flex gap-2">
        <input className={field} placeholder="Search name, company, phone, city" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={field} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Any state</option>
          {["new", "contacted", "in_conversation", "do_not_contact", "opted_out"].map((s) => <option key={s}>{s}</option>)}
        </select>
        <button className={btn} type="submit">Filter</button>
        <label className={`${btn} cursor-pointer`}>
          Import CSV
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </form>
      <form onSubmit={add} className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-5">
        <input className={field} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input className={field} placeholder="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
        <input className={field} placeholder="07x or +46" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
        <input className={field} placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        <button className={go} type="submit">Add</button>
      </form>
      <p className="mb-3 text-xs text-zinc-500">{data ? `${data.total} leads. A number is eligible only after hitta.se shows that person's full mobile, or you confirm it. Landlines and 010/020 numbers never send.` : "Loading…"}</p>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500"><tr><th className="py-2">Lead</th><th>Phone</th><th>State</th><th>Validation</th><th></th></tr></thead>
        <tbody>
          {(data?.rows ?? []).map((row) => (
            <tr key={row.id} className="border-t border-zinc-900 align-top">
              <td className="py-2">
                <div>{row.name || "—"}</div>
                <div className="text-xs text-zinc-500">{row.company}{row.city ? ` · ${row.city}` : ""}</div>
              </td>
              <td className="font-mono text-xs">{row.phone_e164}<div className="mt-1"><CallLinks phone={row.phone_e164} /></div></td>
              <td>
                <select className={field} value={row.contact_state} onChange={(e) => mark(row.id, e.target.value)}>
                  {["new", "contacted", "in_conversation", "do_not_contact", "opted_out"].map((s) => <option key={s}>{s}</option>)}
                </select>
              </td>
              <td className="max-w-xs text-xs text-zinc-400">
                {row.eligible ? <span className="text-emerald-300">Eligible mobile</span> : row.kind || "Not checked"}
                <div>{row.validation_detail}</div>
                {row.hitta_url && <a className="text-zinc-300 underline" href={row.hitta_url} target="_blank" rel="noreferrer">Open hitta.se</a>}
              </td>
              <td className="space-y-1 text-right">
                <button type="button" className={btn} onClick={() => validate(row.id)}>Re-validate</button>
                {row.kind === "mobile" && !row.eligible && (
                  <button type="button" className={btn} onClick={() => validate(row.id, true, Boolean(row.switchboard))}>
                    {row.switchboard ? "Confirm anyway" : "Confirm owner mobile"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

export function Inbox() {
  const { data, error } = useLoad<{ threads: any[] }>("/api/sms/inbox");
  return (
    <Frame>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Inbox</h1>
      <ErrorNote error={error} />
      <ul className="divide-y divide-zinc-900 rounded border border-zinc-800">
        {(data?.threads ?? []).map((row) => (
          <li key={row.id}>
            <Link href={`/sms/inbox/${row.id}`} className="flex items-baseline gap-3 px-3 py-3 hover:bg-zinc-900">
              <span className="w-40 truncate">{row.name || row.phone_e164}</span>
              <span className="w-40 truncate text-sm text-zinc-500">{row.company}</span>
              <span className="flex-1 truncate text-sm text-zinc-300">{row.last_body}</span>
              {row.classification && <Pill value={row.classification} />}
            </Link>
          </li>
        ))}
        {data && !data.threads.length && <li className="px-3 py-6 text-sm text-zinc-500">No conversations yet.</li>}
      </ul>
    </Frame>
  );
}

export function Thread({ id }: { id: string }) {
  const { data, error, reload, setError } = useLoad<any>(`/api/sms/inbox/${id}`);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  async function reply(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      await api(`/api/sms/inbox/${id}`, { method: "POST", body: JSON.stringify({ message }) });
      setMessage("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }
  if (!data) return <Frame><ErrorNote error={error} /><p className="text-zinc-500">Loading…</p></Frame>;
  const c = data.contact;
  return (
    <Frame>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{c.name || c.phone_e164}</h1>
          <p className="text-sm text-zinc-400">{c.company} · <span className="font-mono">{c.phone_e164}</span></p>
        </div>
        <CallLinks phone={c.phone_e164} />
      </div>
      <ErrorNote error={error} />
      <ol className="space-y-3">
        {data.messages.map((m: any) => (
          <li key={m.id} className={`max-w-xl rounded border px-3 py-2 text-sm ${m.direction === "out" ? "ml-auto border-zinc-700" : "border-zinc-800"}`}>
            <div className="mb-1 text-xs text-zinc-500">{m.direction === "out" ? "You" : "Them"} · {m.created_at?.slice(0, 16).replace("T", " ")} {m.classification && `· ${m.classification}`}</div>
            <div className="whitespace-pre-wrap">{m.body}</div>
            {m.classification_reason && <div className="mt-1 text-xs text-zinc-500">{m.classification_reason}</div>}
          </li>
        ))}
      </ol>
      <form onSubmit={reply} className="mt-6 flex gap-2">
        <input className={`${field} flex-1`} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Reply. Same daily cap and pacing as campaigns." />
        <button className={go} disabled={sending || !message.trim()} type="submit">Send</button>
      </form>
    </Frame>
  );
}

export function Positive() {
  const { data, error } = useLoad<{ replies: any[] }>("/api/sms/positive");
  return (
    <Frame>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Positive replies</h1>
      <ErrorNote error={error} />
      <ul className="space-y-3">
        {(data?.replies ?? []).map((row) => (
          <li key={row.id} className="rounded border border-amber-900/60 bg-zinc-950 px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <Link href={`/sms/inbox/${row.contact_id}`} className="font-medium hover:underline">{row.name || row.phone_e164} · {row.company}</Link>
              <span className="font-mono text-xs text-zinc-400">{row.phone_e164}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{row.body}</p>
            <p className="mt-1 text-xs text-zinc-500">{row.classification_reason} {row.notified_at ? `· SMS alert sent` : row.notify_error ? `· alert failed: ${row.notify_error}` : ""}</p>
            <div className="mt-2"><CallLinks phone={row.phone_e164} /></div>
          </li>
        ))}
        {data && !data.replies.length && <li className="text-sm text-zinc-500">No positive replies yet.</li>}
      </ul>
    </Frame>
  );
}

export function Settings() {
  const { data, error, reload, setError } = useLoad<any>("/api/sms/settings");
  const [form, setForm] = useState<any>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/sms/settings", { method: "PUT", body: JSON.stringify(form) });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }
  if (!form) return <Frame><ErrorNote error={error} /><p className="text-zinc-500">Loading…</p></Frame>;
  return (
    <Frame>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mb-4 max-w-xl text-sm text-zinc-400">46elks credentials stay in the environment. These controls are the send ceiling. The gap cannot go under 45 seconds, and the daily limit cannot go over the hard cap.</p>
      <ErrorNote error={error} />
      <form onSubmit={save} className="max-w-md space-y-3">
        <label className="block text-xs text-zinc-500">Notification number
          <input className={`${field} mt-1 w-full`} value={form.notifyNumber} onChange={(e) => setForm({ ...form, notifyNumber: e.target.value })} placeholder="+4670…" />
        </label>
        <label className="block text-xs text-zinc-500">Daily limit
          <input className={`${field} mt-1 w-full`} type="number" min={1} max={200} value={form.dailyLimit} onChange={(e) => setForm({ ...form, dailyLimit: Number(e.target.value) })} />
        </label>
        <div className="flex gap-2">
          <label className="block flex-1 text-xs text-zinc-500">Window start
            <input className={`${field} mt-1 w-full`} value={form.windowStart} onChange={(e) => setForm({ ...form, windowStart: e.target.value })} />
          </label>
          <label className="block flex-1 text-xs text-zinc-500">Window end
            <input className={`${field} mt-1 w-full`} value={form.windowEnd} onChange={(e) => setForm({ ...form, windowEnd: e.target.value })} />
          </label>
        </div>
        <label className="block text-xs text-zinc-500">Minimum seconds between sends
          <input className={`${field} mt-1 w-full`} type="number" min={45} max={3600} value={form.minGapSeconds} onChange={(e) => setForm({ ...form, minGapSeconds: Number(e.target.value) })} />
        </label>
        <label className="block text-xs text-zinc-500">Public URL for links in alerts
          <input className={`${field} mt-1 w-full`} value={form.publicUrl} onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.weekdaysOnly} onChange={(e) => setForm({ ...form, weekdaysOnly: e.target.checked })} />
          Weekdays only
        </label>
        <button className={go} type="submit">Save</button>
      </form>
    </Frame>
  );
}

export function Login() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ authRequired: boolean; ok: boolean }>("/api/sms/session").then((s) => {
      if (!s.authRequired || s.ok) router.replace("/sms");
    }).catch(() => {});
  }, [router]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/sms/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    if (!res.ok) {
      setError("Wrong password");
      return;
    }
    router.replace("/sms");
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100 font-[family-name:var(--font-geist-sans)]">
      <form onSubmit={submit} className="w-80 space-y-3 rounded border border-zinc-800 p-5">
        <h1 className="text-lg font-semibold">SMS campaigns</h1>
        <input className={`${field} w-full`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus />
        {error && <p className="text-sm text-red-300">{error}</p>}
        <button className={`${go} w-full`} type="submit">Sign in</button>
      </form>
    </div>
  );
}
