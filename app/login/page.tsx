"use client";

import { useState } from "react";

/** Minimal password gate for hosted deployments — sets the auth cookie via /api/login. */
export default function LoginPage() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    }).catch(() => null);
    if (res?.ok) {
      window.location.href = "/";
      return;
    }
    setErr(res ? "Wrong password" : "Network error");
    setBusy(false);
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
      <form onSubmit={submit} className="flex flex-col gap-3 w-72">
        <h1 className="text-lg font-semibold tracking-tight">RapidDial</h1>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Password"
          className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 outline-none focus:border-zinc-500"
        />
        <button
          disabled={busy || !pw}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded px-3 py-2 font-medium"
        >
          {busy ? "…" : "Enter"}
        </button>
        {err && <p className="text-red-400 text-sm">{err}</p>}
      </form>
    </main>
  );
}
