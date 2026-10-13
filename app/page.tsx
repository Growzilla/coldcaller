"use client";

/**
 * RapidDial cockpit — single-screen power dialer.
 * Keyboard: P call · H hangup · 1–5 outcome · Enter save+next · S skip · O website · L LinkedIn
 * (modifier combos like Ctrl/Cmd+C are ignored so copy/paste never triggers a shortcut)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { startCallRecording, stopCallRecording, recordingActive } from "@/lib/recorder";

type Lead = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company: string;
  phone_e164: string | null;
  email: string | null;
  linkedin: string | null;
  website: string | null;
  city: string | null;
  country: string | null;
  industry: string | null;
  employees: string | null;
  priority: number;
  prior_notes: string | null;
};

type InboundCaller = {
  from: string;
  lead: Lead | null;
  stats: { calls: number; talk_s: number; last_at: string | null; last_outcome: string | null } | null;
};

type Session = { id: number; status: string; mode?: string } | null;
type Call = { id: number; lead_id: number; vonage_status: string | null; ended_at: string | null; answered_at: string | null } | null;
type Counts = { queued: number; done: number; callsToday: number };
type SmsRow = {
  id: string;
  from_e164: string | null;
  to_e164: string | null;
  message: string | null;
  created_at: string | null;
  received_at: string;
};
type VerifyRow = {
  id: string;
  callid: string | null;
  from_e164: string | null;
  code: string | null;
  transcript: string | null;
  received_at: string;
};

const OUTCOMES = [
  { key: "1", value: "no_answer", label: "No answer", cls: "border-zinc-700 text-zinc-300" },
  { key: "2", value: "callback", label: "Callback", cls: "border-sky-700 text-sky-300" },
  { key: "3", value: "interested", label: "Interested", cls: "border-emerald-700 text-emerald-300" },
  { key: "4", value: "not_interested", label: "Not interested", cls: "border-zinc-700 text-zinc-400" },
  { key: "5", value: "bad_number", label: "Bad number", cls: "border-red-800 text-red-400" },
];

const fullUrl = (u: string | null) => (u ? (/^https?:\/\//.test(u) ? u : `http://${u}`) : null);

/**
 * Vonage Client SDK v2.3.1 receives the remote audio track but does NOT attach it to an
 * <audio> element, so nothing plays to the speakers (confirmed: media packets flow, but
 * 0 audio elements in the DOM). Patch RTCPeerConnection so every inbound audio track is
 * piped into a single autoplay <audio> element. Idempotent; safe to call repeatedly.
 */
/** Route a media element to the operator's chosen speaker (window.__sinkId), if any. */
function applySink(el: HTMLMediaElement) {
  const id = (window as any).__sinkId;
  if (id && (el as any).setSinkId) (el as any).setSinkId(id).catch(() => {});
}
function ensureRemoteAudioPlayback() {
  const w = window as any;
  if (w.__rtcAudioPatched) return;
  const Orig = w.RTCPeerConnection;
  if (!Orig) return;
  w.__rtcAudioPatched = true;
  function Patched(this: any, ...args: any[]) {
    const pc = new Orig(...args);
    w.__rtcPcCount = (w.__rtcPcCount || 0) + 1; // diag: did the SDK use the patched PC?
    (w.__rtcPcs ||= []).push(pc); // line-check reads sender stats; liveness watcher reads state
    pc.addEventListener("connectionstatechange", () => {
      w.__rtcConnState = pc.connectionState;
    });
    pc.addEventListener("track", (ev: RTCTrackEvent) => {
      if (ev.track.kind !== "audio") return;
      w.__rtcTrackCount = (w.__rtcTrackCount || 0) + 1; // diag: inbound audio track arrived
      // Stash the raw remote track for the call recorder (lib/recorder.ts) — capturing at
      // the source survives srcObject swaps below, which used to make recordings mic-only.
      (w.__rtcRemoteTracks ||= []).push(ev.track);
      w.__recorderAddTrack?.(ev.track);
      let el = document.getElementById("rtc-remote-audio") as HTMLAudioElement | null;
      if (!el) {
        el = document.createElement("audio");
        el.id = "rtc-remote-audio";
        el.autoplay = true;
        (el as any).playsInline = true;
        document.body.appendChild(el);
      }
      el.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      el.muted = false;
      el.volume = 1;
      applySink(el); // route to the chosen speaker
      el.play().catch(() => {});
    });
    // expose the outgoing mic track so the recorder can reuse it instead of opening a 2nd mic
    const grabSent = () => {
      const sender = pc.getSenders?.().find((s: any) => s.track && s.track.kind === "audio");
      if (sender?.track) w.__sdkMicTrack = sender.track;
      else w.__micMeterT = setTimeout(grabSent, 500);
    };
    w.__micMeterT = setTimeout(grabSent, 800);
    return pc;
  }
  Patched.prototype = Orig.prototype;
  w.RTCPeerConnection = Patched;
  w.webkitRTCPeerConnection = Patched;
}

/**
 * The Vonage SDK captures from the browser DEFAULT mic with no input-device API.
 * Patch getUserMedia so audio capture (the meter AND the SDK call) honors the mic chosen
 * in the cockpit (window.__micDeviceId). Idempotent.
 */
function applyMicConstraint() {
  const w = window as any;
  const md = navigator.mediaDevices;
  if (w.__gumPatched || !md?.getUserMedia) return;
  w.__gumPatched = true;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = (constraints: MediaStreamConstraints = {}) => {
    const id = w.__micDeviceId;
    if (constraints.audio) {
      const base = typeof constraints.audio === "object" ? constraints.audio : {};
      // Ask for voice processing EXPLICITLY: `audio: true` leaves AEC to browser defaults, which
      // Firefox/Waterfox drops for some devices (stereo USB mics like the Blue) → prospect hears
      // themselves echo off our speakers. Mono also keeps the AEC path engaged.
      constraints = {
        ...constraints,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          ...base,
          ...(id ? { deviceId: { exact: id } } : {}),
        },
      };
    }
    return orig(constraints);
  };
}

export default function Cockpit() {
  const [ready, setReady] = useState<string | null>(null);
  const [callerId, setCallerId] = useState("");
  const [callerRegion, setCallerRegion] = useState<"US" | "SE">("SE");
  const [callerOverride, setCallerOverride] = useState<"US" | "SE" | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceCurrency, setBalanceCurrency] = useState("EUR");
  const [provider, setProvider] = useState<"vonage" | "46elks">("vonage");
  const [operatorPhone, setOperatorPhone] = useState("");
  const [operatorPhoneDraft, setOperatorPhoneDraft] = useState("");
  const [session, setSession] = useState<Session>(null);
  const [call, setCall] = useState<Call>(null);
  const [lead, setLead] = useState<Lead | null>(null);
  const [queue, setQueue] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Counts>({ queued: 0, done: 0, callsToday: 0 });
  const [outcome, setOutcome] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [embeddable, setEmbeddable] = useState(false);
  const [region, setRegion] = useState("");
  const [countries, setCountries] = useState<{ country: string; n: number }[]>([]);
  const [source, setSource] = useState("");
  const [sources, setSources] = useState<{ source: string; n: number }[]>([]);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const leadRef = useRef<Lead | null>(null);
  leadRef.current = lead;
  const regionRef = useRef("");
  regionRef.current = region;
  const sourceRef = useRef("");
  sourceRef.current = source;
  // Browser (WebRTC) line — Vonage Client SDK instance + its active call id
  const rtcRef = useRef<{ client: any; callId: string | null }>({ client: null, callId: null });
  // 46elks browser line — JsSIP user agent
  const elksRtcRef = useRef<{ ua: any; session: any }>({ ua: null, session: null });
  /** Every live 46elks SIP leg — hang up must kill all of them, not just the newest. */
  const elksSessionsRef = useRef<Set<any>>(new Set());
  /** Hang up pressed before /api/call returned → reject that dial's leg when it reaches the browser. */
  const cancelledDialRef = useRef(false);
  /**
   * 46elks delivers EVERY leg to the browser as an incoming SIP call. Our own legs (lead dials, test
   * calls, audio checks) are expected → auto-answer; anything else is a real inbound caller → ring.
   */
  const expectOutboundUntilRef = useRef(0);
  const ringSessRef = useRef<any>(null);
  const ringToneRef = useRef<{ ac: AudioContext; iv: ReturnType<typeof setInterval> } | null>(null);
  const [ringing, setRinging] = useState<{ from: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [smsInbox, setSmsInbox] = useState<SmsRow[]>([]);
  const [verifyInbox, setVerifyInbox] = useState<VerifyRow[]>([]);
  const [verifyRinging, setVerifyRinging] = useState(false);
  /** off | listen | missed | forward — from /api/elks/verify-mode */
  const [verifyMode, setVerifyMode] = useState<"off" | "listen" | "missed" | "forward">("off");
  const [smsOpen, setSmsOpen] = useState(true);
  const [smsTo, setSmsTo] = useState("");
  const [smsBody, setSmsBody] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [intel, setIntel] = useState<{ company?: string; analysis: any } | null>(null);
  const [inbound, setInbound] = useState<InboundCaller | null>(null);
  // Solid-state line: verified-audio status, media liveness, reload-orphan handling
  const [lineCheck, setLineCheck] = useState<null | {
    running: boolean;
    hear?: boolean;
    hearRms?: number;
    send?: boolean;
    sentKb?: number;
  }>(null);
  const [connDead, setConnDead] = useState(false);
  const startInFlightRef = useRef(false); // startLineRtc in progress — don't reap its session
  const checkedSessionRef = useRef<number | null>(null); // auto line-check ran for this session
  // WebRTC audio diagnostics (browser line)
  const [micLevel, setMicLevel] = useState(0);
  const [rtcDiag, setRtcDiag] = useState<string>("");
  const [micDevices, setMicDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>("");
  const [micActive, setMicActive] = useState(false); // meter running standalone (no live call)
  const [outputDevices, setOutputDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState<string>(""); // chosen speaker (setSinkId)
  const diagRef = useRef<{ raf?: number; poll?: ReturnType<typeof setInterval>; micPoll?: ReturnType<typeof setInterval>; ac?: AudioContext; mic?: MediaStream }>({});
  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  }, []);

  // P pressed, /api/call not back yet (makeCall takes seconds): already "in a call" for P/H/buttons.
  const [dialing, setDialing] = useState(false);
  const callActive = (!!call && !call.ended_at) || dialing;
  const callStatus = call?.vonage_status ?? null;
  const prevCallStatusRef = useRef<string | null>(null);
  const callActiveRef = useRef(false);
  callActiveRef.current = callActive;
  const inWrapup = !!call && !!call.ended_at && call.lead_id === lead?.id && !busy;
  const sessionLive = session?.status === "live";

  const refreshSmsInbox = useCallback(async () => {
    const d = await fetch("/api/elks/sms/inbox").then((r) => r.json()).catch(() => null);
    if (d?.messages) setSmsInbox(d.messages);
  }, []);

  const sendSmsNow = useCallback(async () => {
    const to = (smsTo || leadRef.current?.phone_e164 || "").trim();
    const message = smsBody.trim();
    if (!to) return flash("Enter a number to text");
    if (!message) return;
    setSmsSending(true);
    try {
      const d = await fetch("/api/elks/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, message }),
      }).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setSmsBody("");
      flash(`💬 Sent to ${d.to}${d.costSek != null ? ` · ${d.costSek.toFixed(2)} SEK` : ""}`);
      refreshSmsInbox();
    } catch (e: any) {
      flash(`⚠ SMS failed: ${e?.message || e}`);
    } finally {
      setSmsSending(false);
    }
  }, [smsTo, smsBody, flash, refreshSmsInbox]);

  const refreshVerifyInbox = useCallback(async () => {
    const d = await fetch("/api/elks/verify/inbox").then((r) => r.json()).catch(() => null);
    if (d?.verifications) setVerifyInbox(d.verifications);
    if (d?.mode === "listen" || d?.mode === "missed" || d?.mode === "forward" || d?.mode === "off") {
      setVerifyMode(d.mode);
    }
  }, []);

  const setVerifyModeApi = useCallback(
    async (mode: "off" | "listen" | "missed" | "forward") => {
      const d = await fetch("/api/elks/verify-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      })
        .then((r) => r.json())
        .catch(() => null);
      if (d?.mode) {
        setVerifyMode(d.mode);
        flash(
          d.mode === "missed"
            ? "📵 Missed-call mode — will NOT answer; CLI last digits = OTP"
            : d.mode === "listen"
              ? "🎙 Voice OTP mode — answers + records spoken code"
              : d.mode === "forward"
                ? "📲 Forward mode — bridges to your mobile"
                : "Verify capture OFF"
        );
      } else {
        flash(d?.error || "Failed to set verify mode");
      }
    },
    [flash]
  );

  const refresh = useCallback(async () => {
    const qs = new URLSearchParams();
    if (regionRef.current) qs.set("country", regionRef.current);
    if (sourceRef.current) qs.set("source", sourceRef.current);
    const s = await fetch(`/api/state${qs.toString() ? `?${qs}` : ""}`).then((r) => r.json());
    setReady(s.ready);
    setCallerId(s.callerId);
    setCallerRegion(s.callerRegion ?? "SE");
    setCallerOverride(s.callerOverride ?? null);
    setBalance(s.balance);
    setBalanceCurrency(s.balanceCurrency ?? "EUR");
    setProvider(s.provider ?? "vonage");
    setOperatorPhone(s.operatorPhone ?? "");
    setOperatorPhoneDraft(s.operatorPhone ?? "");
    setSession(s.session);
    setCall(s.call);
    setLead(s.currentLead);
    setQueue(s.queue);
    setCounts(s.counts);
    setCountries(s.countries ?? []);
    setSources(s.sources ?? []);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("dialer-region") ?? "";
    regionRef.current = saved;
    setRegion(saved);
    // `coldcall` opens ?source=ghl so the GHL queue (best ICP first) is what you dial.
    const qsSource = new URLSearchParams(window.location.search).get("source");
    if (qsSource !== null) localStorage.setItem("dialer-source", qsSource);
    const savedSource = localStorage.getItem("dialer-source") ?? "";
    sourceRef.current = savedSource;
    setSource(savedSource);
    const savedProvider = localStorage.getItem("dialer-provider");
    const savedOperator = localStorage.getItem("dialer-operator-phone");
    const qs = new URLSearchParams(window.location.search);
    const smsMode = qs.get("sms") === "1";
    const verifyQ = qs.get("verify");
    const boot = async () => {
      if (smsMode) {
        await fetch("/api/provider", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "46elks" }),
        });
        localStorage.setItem("dialer-provider", "46elks");
        setSmsOpen(true);
        if (verifyQ === "missed" || verifyQ === "listen" || verifyQ === "forward" || verifyQ === "off") {
          await fetch("/api/elks/verify-mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: verifyQ }),
          }).catch(() => {});
          setVerifyMode(verifyQ);
        }
      } else if (qs.get("provider") === "46elks" || qs.get("provider") === "vonage") {
        // `coldcall` opens ?provider=… — the boot script's choice beats a stale saved one.
        const p = qs.get("provider")!;
        await fetch("/api/provider", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: p }),
        });
        localStorage.setItem("dialer-provider", p);
      } else if (savedProvider === "46elks" || savedProvider === "vonage") {
        await fetch("/api/provider", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: savedProvider }),
        });
      }
      if (savedOperator) {
        await fetch("/api/operator-phone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: savedOperator }),
        }).catch(() => {});
      }
      await refresh();
    };
    boot().then(() => {
      refreshSmsInbox();
      refreshVerifyInbox();
    });
  }, [refresh, refreshSmsInbox, refreshVerifyInbox]);

  // Audio devices: patch getUserMedia, restore saved mic + speaker, list in/out (refresh on hot-plug)
  useEffect(() => {
    applyMicConstraint();
    const saved = localStorage.getItem("dialer-mic") ?? "";
    if (saved) {
      setMicDeviceId(saved);
      (window as any).__micDeviceId = saved;
    }
    const savedOut = localStorage.getItem("dialer-output") ?? "";
    if (savedOut) {
      setOutputDeviceId(savedOut);
      (window as any).__sinkId = savedOut;
    }
    const load = () =>
      navigator.mediaDevices
        ?.enumerateDevices?.()
        .then((ds) => {
          setMicDevices(
            ds.filter((d) => d.kind === "audioinput").map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 4)}` }))
          );
          setOutputDevices(
            ds.filter((d) => d.kind === "audiooutput").map((d) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 4)}` }))
          );
        })
        .catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", load);
  }, []);

  const changeRegion = useCallback(
    (r: string) => {
      regionRef.current = r;
      setRegion(r);
      localStorage.setItem("dialer-region", r);
      refresh();
    },
    [refresh]
  );

  const changeSource = useCallback(
    (v: string) => {
      sourceRef.current = v;
      setSource(v);
      localStorage.setItem("dialer-source", v);
      refresh();
    },
    [refresh]
  );

  useEffect(() => {
    const st = call?.vonage_status ?? null;
    if (st === "failed" && prevCallStatusRef.current !== "failed" && provider === "46elks") {
      const op = operatorPhone || operatorPhoneDraft;
      const hint = op.startsWith("+46")
        ? "Call failed — check signal / number and try again"
        : "Call failed — set your Swedish mobile (+46…) in the header first";
      flash(`⚠ ${hint}`);
    }
    prevCallStatusRef.current = st;
  }, [call?.vonage_status, provider, operatorPhone, operatorPhoneDraft, flash]);

  // Live updates from the server-side Vonage poller
  useEffect(() => {
    const es = new EventSource("/api/events/stream");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "session") setSession(e.payload);
      if (e.type === "call") setCall(e.payload);
      if (e.type === "intel") setIntel({ analysis: e.payload.analysis });
      if (e.type === "booked") flash(`🎉 ${e.payload.company} BOOKED a meeting (${e.payload.start})`);
      if (e.type === "inbound") {
        const p = e.payload as InboundCaller;
        setInbound(p);
        // Swap the lead card to the caller so their notes/history are in front of you
        // and 1–5+Enter logs the outcome against the right person.
        if (p.lead) {
          setLead(p.lead);
          setOutcome(null);
          setNotes("");
        }
      }
      if (e.type === "sms") {
        const row = e.payload as SmsRow;
        setSmsInbox((prev) => [row, ...prev.filter((m) => m.id !== row.id)].slice(0, 30));
        const outbound = (row.from_e164 || "").replace(/\D/g, "") === "46766861525";
        if (!outbound) {
          setSmsOpen(true);
          flash(`📩 SMS from ${row.from_e164 ?? "unknown"}`);
        }
      }
      if (e.type === "verify") {
        const p = e.payload as {
          status?: string;
          kind?: string;
          code?: string | null;
          candidates?: string[];
          digits?: string;
          transcript?: string;
          from?: string | null;
        };
        if (p.status === "ringing") {
          setVerifyRinging(true);
          setSmsOpen(true);
          flash("📞 Verification call incoming on +46766861525…");
        } else {
          setVerifyRinging(false);
          setSmsOpen(true);
          void refreshVerifyInbox();
          if (p.kind === "missed" || p.status === "missed") {
            const cands = p.candidates?.length ? p.candidates.join(" / ") : p.code || "";
            flash(
              p.code
                ? `📵 Missed-call OTP: ${p.code}${p.candidates && p.candidates.length > 1 ? ` (also try ${p.candidates.slice(1).join(", ")})` : ""} — click to copy`
                : `📵 Missed call from ${p.from || "?"} — ${cands || "no CLI digits"}`
            );
          } else if (p.code) flash(`🔊 Voice OTP: ${p.code} — click to copy`);
          else if (p.digits)
            flash(`🔊 Partial digits: ${p.digits} (${p.digits.length}/6) — check panel / retry`);
          else flash("🔊 Verification call recorded — check voice OTP panel");
        }
      }
    };
    return () => es.close();
  }, [flash]);

  // Reload-orphan reaper. An rtc session's audio lives in THIS page's WebRTC connection —
  // a reload destroys the media but leaves the DB session "live" and a zombie leg at Vonage
  // (exactly the 2026-06-12 dead-air incident: cockpit said Line live, room had no browser).
  // An active rtc session observed RIGHT AFTER page load that this page doesn't own is a
  // corpse from the previous load: end it. Only within 15s of mount — a session appearing
  // later belongs to another context (test harness, second tab) and must be left alone.
  const mountedAtRef = useRef(Date.now());
  useEffect(() => {
    if (Date.now() - mountedAtRef.current > 15_000) return;
    if (!session || session.mode !== "rtc") return;
    if (session.status !== "starting" && session.status !== "live") return;
    if (rtcRef.current.client || startInFlightRef.current) return;
    fetch("/api/session/end", { method: "POST" })
      .then(() => {
        flash("♻️ Found a stale browser line from before a reload — ended it. Hit 🎧 Start line.");
        refresh();
      })
      .catch(() => {});
  }, [session, refresh, flash]);

  // Per-call recording: roll while the lead leg is answered (browser-line sessions only)
  useEffect(() => {
    if (session?.mode !== "rtc") return;
    if (callActive && callStatus === "answered" && !recordingActive()) {
      startCallRecording().catch(() => flash("⚠ mic capture failed — call not recorded"));
    }
    if (!callActive && call?.id && recordingActive()) {
      void stopCallRecording(call.id);
    }
  }, [callActive, callStatus, call?.id, session?.mode, flash]);

  // Call timer
  useEffect(() => {
    if (!callActive || callStatus !== "answered") return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
  }, [callActive, callStatus]);
  useEffect(() => {
    if (!callActive) return;
    if (callStatus !== "answered") setElapsed(0);
  }, [callActive, callStatus]);

  // Website embeddability check per lead
  useEffect(() => {
    setEmbeddable(false);
    const url = fullUrl(lead?.website ?? null);
    if (!url) return;
    let alive = true;
    fetch(`/api/sitecheck?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((d) => alive && setEmbeddable(!!d.embeddable))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lead?.id, lead?.website]);

  const api = useCallback(async (path: string, body?: any) => {
    setError(null);
    if (path === "/api/call" || path === "/api/test-call") expectOutboundUntilRef.current = Date.now() + 45_000;
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
      if (path === "/api/call" || path === "/api/test-call") expectOutboundUntilRef.current = 0; // no leg coming
      setError(data.error || "Request failed");
      throw new Error(data.error);
    }
    return data;
  }, []);

  const undo = useCallback(() => {
    api("/api/undo", { country: regionRef.current || undefined, source: sourceRef.current || undefined })
      .then((d) => {
        setLead(d.currentLead);
        setQueue(d.queue);
        setCounts(d.counts);
        setOutcome(null);
        setNotes("");
      })
      .catch(() => {});
  }, [api]);

  const saveOperatorPhone = useCallback(async () => {
    const raw = operatorPhoneDraft.trim();
    if (!raw) return;
    if (session) {
      flash("End the line before changing your phone number");
      return;
    }
    const res = await fetch("/api/operator-phone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: raw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Invalid phone number");
      return;
    }
    setError(null);
    setOperatorPhone(data.phone ?? raw);
    setOperatorPhoneDraft(data.phone ?? raw);
    localStorage.setItem("dialer-operator-phone", data.phone ?? raw);
    flash(`📱 Your phone set to ${data.phone}`);
    await refresh();
  }, [operatorPhoneDraft, session, flash, refresh]);

  const startLine = useCallback(async () => {
    if (provider === "46elks") {
      const raw = operatorPhoneDraft.trim();
      if (!raw) {
        flash("Enter your Swedish mobile (+46… or 07x…) first — or use 🎧 browser line");
        return;
      }
      if (raw !== operatorPhone) await saveOperatorPhone();
      const phone = operatorPhone || raw;
      if (!phone.startsWith("+46")) {
        flash("46elks phone mode needs a Swedish mobile — or use 🎧 browser line");
        return;
      }
    }
    await api("/api/session/start", { mode: "phone" }).catch(() => {});
  }, [api, provider, operatorPhoneDraft, operatorPhone, saveOperatorPhone, flash]);

  const switchProvider = useCallback(
    async (next: "vonage" | "46elks") => {
      if (session) {
        flash("End the line before switching provider");
        return;
      }
      await fetch("/api/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: next }),
      });
      localStorage.setItem("dialer-provider", next);
      await refresh();
      flash(next === "46elks" ? "🇸🇪 46elks — calls from +46766861525" : "Vonage provider active");
    },
    [session, flash, refresh]
  );

  /** Stop all WebRTC diagnostics (mic meter + remote-audio poll). */
  const stopDiag = useCallback(() => {
    const d = diagRef.current;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (d.poll) clearInterval(d.poll);
    if (d.micPoll) clearInterval(d.micPoll);
    d.ac?.close().catch(() => {});
    d.mic?.getTracks().forEach((t) => t.stop());
    diagRef.current = {};
    const w = window as any;
    if (w.__micMeterRaf) cancelAnimationFrame(w.__micMeterRaf);
    if (w.__micMeterT) clearTimeout(w.__micMeterT);
    w.__rtcRemoteTracks = []; // dead session's tracks — recorder filters non-live anyway
    w.__rtcPcs = [];
    w.__rtcConnState = undefined;
    w.__localMicLevel = 0;
    setMicLevel(0);
    setMicActive(false);
    setRtcDiag("");
    setConnDead(false);
    setLineCheck(null);
    checkedSessionRef.current = null;
    const a = document.getElementById("rtc-remote-audio") as HTMLAudioElement | null;
    if (a) { try { (a.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop()); } catch {} a.remove(); }
  }, []);

  /** Live mic level meter (own getUserMedia — fine on PipeWire/PulseAudio; multiple readers don't conflict). */
  const startMicMeter = useCallback(async (): Promise<boolean> => {
    if (diagRef.current.raf) cancelAnimationFrame(diagRef.current.raf);
    diagRef.current.ac?.close().catch(() => {});
    diagRef.current.mic?.getTracks().forEach((t) => t.stop());
    try {
      applyMicConstraint();
      let mic: MediaStream;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err: any) {
        // A pinned mic (window.__micDeviceId) can go stale (reconnect / browser restart
        // rotates the deviceId) → exact-constraint throws. Fall back to the default mic.
        if ((window as any).__micDeviceId && /Overconstrained|NotFound|NotReadable/i.test(err?.name || "")) {
          (window as any).__micDeviceId = "";
          setMicDeviceId("");
          mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          setRtcDiag("🎤 chosen mic unavailable — using system default");
        } else throw err;
      }
      navigator.mediaDevices
        ?.enumerateDevices?.()
        .then((ds) => setMicDevices(ds.filter((d) => d.kind === "audioinput").map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 4)}` }))))
        .catch(() => {});
      const ac = new AudioContext();
      ac.resume().catch(() => {});
      const an = ac.createAnalyser();
      an.fftSize = 512;
      ac.createMediaStreamSource(mic).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      diagRef.current.mic = mic;
      diagRef.current.ac = ac;
      setMicActive(true);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setMicLevel(Math.min(100, Math.round((peak / 128) * 140)));
        diagRef.current.raf = requestAnimationFrame(tick);
      };
      tick();
      return true;
    } catch (e: any) {
      setMicActive(false);
      setRtcDiag(`🎤 MIC BLOCKED (${e?.name || e}) — click the address-bar 🎙 icon → Allow, then End + Start line.`);
      return false;
    }
  }, []);

  /** Pick the mic for the meter + call. Live-restart the meter; End + Start to apply to a live call. */
  const selectMic = useCallback((id: string) => {
    setMicDeviceId(id);
    localStorage.setItem("dialer-mic", id);
    (window as any).__micDeviceId = id;
    applyMicConstraint();
    if (diagRef.current.mic) startMicMeter();
  }, [startMicMeter]);

  /** Pick the speaker. Routes call audio (and any live remote-audio element) to it via setSinkId. */
  const selectOutput = useCallback((id: string) => {
    setOutputDeviceId(id);
    localStorage.setItem("dialer-output", id);
    (window as any).__sinkId = id;
    document.querySelectorAll("audio").forEach((el) => {
      if (id && (el as any).setSinkId) (el as any).setSinkId(id).catch(() => {});
    });
  }, []);

  /** Play a 0.4s test tone through the chosen speaker — proves output works before a call. */
  const testOutput = useCallback(async () => {
    try {
      const ac = new AudioContext();
      await ac.resume().catch(() => {});
      const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(dest);
      const el = document.createElement("audio");
      el.autoplay = true;
      el.srcObject = dest.stream;
      if (outputDeviceId && (el as any).setSinkId) await (el as any).setSinkId(outputDeviceId).catch(() => {});
      document.body.appendChild(el);
      await el.play().catch(() => {});
      osc.start();
      flash(`🔊 test tone → ${outputDevices.find((d) => d.deviceId === outputDeviceId)?.label || "default speaker"}`);
      setTimeout(() => { osc.stop(); el.remove(); ac.close().catch(() => {}); }, 450);
    } catch (e: any) {
      flash(`🔊 output test failed: ${e?.name || e}`);
    }
  }, [outputDeviceId, outputDevices, flash]);

  // Auto-connect the mic meter on the first user gesture. getUserMedia is silent once
  // permission is granted, and AudioContext only produces data after a gesture — so this
  // lights up the meter automatically as soon as you touch the page, no need to start the
  // call line first. Fires once; the call line re-uses the same meter if already running.
  useEffect(() => {
    const arm = () => {
      if (!diagRef.current.raf && !diagRef.current.mic) startMicMeter();
    };
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [startMicMeter]);

  /** Watch the SDK's remote <audio> element; defensively un-mute + play it (fixes autoplay-blocked inbound). */
  const pollRemoteAudio = useCallback(() => {
    diagRef.current.poll = setInterval(() => {
      const els = Array.from(document.querySelectorAll("audio")) as HTMLAudioElement[];
      let withTrack = 0;
      let playing = 0;
      for (const el of els) {
        const ms = (el as any).srcObject as MediaStream | null;
        if (ms?.getAudioTracks?.().length) withTrack++;
        try {
          el.muted = false;
          el.volume = 1;
          applySink(el); // keep call audio on the chosen speaker
          if (el.paused) el.play().catch(() => {});
        } catch {}
        if (!el.paused) playing++;
      }
      const w = window as any;
      const pc = w.__rtcPcCount || 0;
      const trk = w.__rtcTrackCount || 0;
      const cs = w.__rtcConnState as string | undefined;
      // media liveness — the dot must not lie. 46elks: every call is its own pc that closes on hangup,
      // so the LINE is the SIP registration; only a failing pc during a live leg means dead media.
      const elks = elksRtcRef.current;
      setConnDead(
        elks.ua
          ? !elks.ua.isRegistered() || (!!elks.session && cs === "failed")
          : cs === "failed" || cs === "closed"
      );
      setRtcDiag(
        els.length
          ? `🔊 ${els.length} audio el · ${withTrack} w/track · ${playing} playing · pc:${pc} trk:${trk}${cs ? ` · ${cs}` : ""}`
          : pc === 0
            ? "⚠️ SDK did not use the patched RTCPeerConnection (pc:0) — remote audio can't attach"
            : trk === 0
              ? `⚠️ peer connected (pc:${pc}) but NO inbound audio track yet — lead leg not bridged into the room`
              : "🔊 no remote audio element yet — waiting for the SDK media leg…"
      );
    }, 1000);
  }, []);

  /** Browser line: mic + speakers instead of your phone. Line cost: €0. */
  const startLineRtc = useCallback(async () => {
    setError(null);
    startInFlightRef.current = true; // shields the new session from the orphan reaper
    ensureRemoteAudioPlayback(); // pipe inbound audio to a real <audio> element BEFORE the SDK builds its PC
    await startMicMeter(); // permission prompt + live mic meter
    try {
      const t = await fetch("/api/rtc/token").then((r) => r.json());
      if (!t.token) throw new Error(t.error || "Could not get RTC token");
      try {
        await api("/api/session/start", { mode: "rtc" });
      } catch (e: any) {
        if (!/already active/i.test(String(e?.message))) throw e;
        // zombie session discovered late (left over from a reload) — reap and retry once
        await fetch("/api/session/end", { method: "POST" });
        await api("/api/session/start", { mode: "rtc" });
      }
      const mod: any = await import("@vonage/client-sdk");
      const client = new mod.VonageClient();
      await client.createSession(t.token);
      const callId = await client.serverCall(); // → answer webhook → joins the room, marks line live
      rtcRef.current = { client, callId };
      setConnDead(false);
      pollRemoteAudio();
    } catch (e: any) {
      setError(`Browser line failed: ${e?.message || e}. Is the tunnel running? (npm run tunnel)`);
      stopDiag();
      fetch("/api/session/end", { method: "POST" }).catch(() => {});
    } finally {
      startInFlightRef.current = false;
    }
  }, [api, startMicMeter, pollRemoteAudio, stopDiag]);

  /** Two-tone ring (Swedish-ish 425 Hz cadence) while an inbound call waits for Answer. Refs only → stable. */
  const startRingTone = useCallback(() => {
    if (ringToneRef.current) return;
    try {
      const ac = new AudioContext();
      const burst = () => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.frequency.value = 425;
        g.gain.setValueAtTime(0.0001, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.05);
        g.gain.setValueAtTime(0.25, ac.currentTime + 0.9);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 1);
        o.connect(g).connect(ac.destination);
        o.start();
        o.stop(ac.currentTime + 1.05);
      };
      burst();
      ringToneRef.current = { ac, iv: setInterval(burst, 3000) };
    } catch {
      /* no audio context — the banner still shows */
    }
    if (typeof document !== "undefined") document.title = "📲 Incoming call — RapidDial";
  }, []);

  const stopRingTone = useCallback(() => {
    const t = ringToneRef.current;
    if (t) {
      clearInterval(t.iv);
      t.ac.close().catch(() => {});
      ringToneRef.current = null;
    }
    if (typeof document !== "undefined") document.title = "RapidDial";
  }, []);

  const answerInbound = useCallback(() => {
    const sess = ringSessRef.current;
    if (!sess) return;
    stopRingTone();
    setRinging(null);
    try {
      sess.answer({ mediaConstraints: { audio: true, video: false } });
    } catch (e: any) {
      setError(`Answer failed: ${e?.message || e}`);
    }
  }, [stopRingTone]);

  const declineInbound = useCallback(() => {
    const sess = ringSessRef.current;
    ringSessRef.current = null;
    stopRingTone();
    setRinging(null);
    try {
      sess?.terminate({ status_code: 486, reason_phrase: "Busy Here" });
    } catch {}
  }, [stopRingTone]);

  /** 46elks browser line — JsSIP WebRTC to +46766861525, no personal phone needed. */
  const startLineElksRtc = useCallback(async () => {
    setError(null);
    startInFlightRef.current = true;
    ensureRemoteAudioPlayback();
    await startMicMeter();
    try {
      const creds = await fetch("/api/elks/rtc/credentials").then((r) => r.json());
      if (creds.error) throw new Error(creds.error);
      try {
        await api("/api/session/start", { mode: "rtc" });
      } catch (e: any) {
        if (!/already active/i.test(String(e?.message))) throw e;
        await fetch("/api/session/end", { method: "POST" });
        await api("/api/session/start", { mode: "rtc" });
      }
      const JsSIP = (await import("jssip")).default;
      const socket = new JsSIP.WebSocketInterface(creds.websocket);
      const ua = new JsSIP.UA({
        sockets: [socket],
        uri: creds.sipUri,
        password: creds.password,
        session_timers: false,
      });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("46elks WebRTC registration timeout (20s)")), 20000);
        ua.on("registered", () => {
          clearTimeout(t);
          resolve();
        });
        ua.on("registrationFailed", (e: any) => {
          clearTimeout(t);
          reject(new Error(e?.cause || "46elks WebRTC registration failed"));
        });
        ua.start();
      });
      ua.on("newRTCSession", (e: any) => {
        const sess = e.session;
        // One call at a time: a second auto-answer leg while one is up is a duplicate dial — reject it.
        // Same for the leg of a dial the operator already hung up on while it was being placed.
        if (e.originator === "remote" && (elksSessionsRef.current.size > 0 || cancelledDialRef.current)) {
          const ours = String(sess.remote_identity?.uri?.user ?? "").replace(/\D/g, "") === String(creds.number).replace(/\D/g, "");
          if (Date.now() < expectOutboundUntilRef.current || ours) {
            cancelledDialRef.current = false;
            try {
              sess.terminate({ status_code: 486, reason_phrase: "Busy Here" });
            } catch {}
            return;
          }
        }
        elksRtcRef.current.session = sess;
        elksSessionsRef.current.add(sess);
        const drop = () => {
          elksSessionsRef.current.delete(sess);
          if (elksRtcRef.current.session === sess) elksRtcRef.current.session = null;
        };
        sess.on("failed", drop);
        sess.on("peerconnection", (ev: any) => {
          // ensureRemoteAudioPlayback() already pipes tracks (+ recorder + speaker sink); fallback only.
          if ((window as any).__rtcAudioPatched) return;
          ev.peerconnection.ontrack = () => {
            const remoteStream = new MediaStream();
            ev.peerconnection.getReceivers().forEach((r: RTCRtpReceiver) => {
              if (r.track) remoteStream.addTrack(r.track);
            });
            let el = document.getElementById("rtc-remote-audio") as HTMLAudioElement | null;
            if (!el) {
              el = document.createElement("audio");
              el.id = "rtc-remote-audio";
              el.autoplay = true;
              document.body.appendChild(el);
            }
            el.srcObject = remoteStream;
            el.play().catch(() => {});
          };
        });
        sess.on("ended", drop);
        if (e.originator === "remote") {
          const fromUser = String(sess.remote_identity?.uri?.user ?? "").replace(/\D/g, "");
          const ours = fromUser === String(creds.number).replace(/\D/g, "");
          if (Date.now() < expectOutboundUntilRef.current || ours) {
            expectOutboundUntilRef.current = 0;
            sess.answer({ mediaConstraints: { audio: true, video: false } });
          } else {
            // Real inbound caller: ring in the cockpit until Answer / Decline / caller hangs up.
            ringSessRef.current = sess;
            setRinging({ from: fromUser ? `+${fromUser}` : "unknown" });
            startRingTone();
            const stop = () => {
              if (ringSessRef.current === sess) {
                ringSessRef.current = null;
                setRinging(null);
                stopRingTone();
              }
            };
            sess.on("failed", stop);
            sess.on("ended", stop);
            sess.on("accepted", stop);
          }
        }
      });
      elksRtcRef.current.ua = ua;
      setConnDead(false);
      pollRemoteAudio();
      flash(`🇸🇪 46elks browser line live — calling from ${creds.number}`);
    } catch (e: any) {
      setError(e?.message || "46elks browser line failed");
      stopDiag();
      try {
        elksRtcRef.current.ua?.stop();
      } catch {}
      elksRtcRef.current = { ua: null, session: null };
      fetch("/api/session/end", { method: "POST" }).catch(() => {});
    } finally {
      startInFlightRef.current = false;
    }
  }, [api, startMicMeter, pollRemoteAudio, stopDiag, flash]);

  const startBrowserLine = useCallback(async () => {
    if (session) await fetch("/api/session/end", { method: "POST" });
    // Server is authoritative: a click before the boot's provider switch lands would otherwise
    // take the Vonage path with stale React state.
    const live = await fetch("/api/provider")
      .then((r) => r.json())
      .then((d) => d.provider as string)
      .catch(() => provider);
    if (live === "46elks") {
      await startLineElksRtc();
      return;
    }
    await startLineRtc();
  }, [provider, session, startLineRtc, startLineElksRtc]);

  const endLine = useCallback(async () => {
    stopDiag();
    const { client, callId } = rtcRef.current;
    if (client) {
      try {
        if (callId) await client.hangup(callId);
      } catch {}
      try {
        client.deleteSession();
      } catch {}
      rtcRef.current = { client: null, callId: null };
    }
    const { ua, session: elksSess } = elksRtcRef.current;
    if (elksSess) {
      try {
        elksSess.terminate();
      } catch {}
    }
    if (ua) {
      try {
        ua.stop();
      } catch {}
      elksRtcRef.current = { ua: null, session: null };
    }
    api("/api/session/end").then(refresh).catch(() => {});
  }, [api, refresh, stopDiag]);
  /**
   * Audio line check — the "solid state" guarantee. Server dials a TTS leg into the room
   * (the exact path a prospect's voice takes); we measure (a) HEAR: peak RMS on the remote
   * audio element while it speaks, (b) SEND: outbound-rtp bytesSent delta (mic flowing out).
   * Green dot = verified audio, not just signaling.
   */
  const runLineCheck = useCallback(async () => {
    if (callActiveRef.current) {
      flash("⚠️ can't run audio check during a call");
      return;
    }
    setLineCheck({ running: true });
    let stopMeter = () => {};
    try {
      // analyser on the remote element's live stream
      const senderBytes = async () => {
        let bytes = 0;
        for (const pc of (((window as any).__rtcPcs as RTCPeerConnection[] | undefined) ?? [])) {
          if (pc.connectionState !== "connected") continue;
          const stats = await pc.getStats();
          stats.forEach((s: any) => {
            if (s.type === "outbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) bytes += s.bytesSent || 0;
          });
        }
        return bytes;
      };
      let peak = 0;
      // Re-attach whenever the remote stream changes: on 46elks the check arrives as a NEW incoming
      // WebRTC call, so the stream (and its peer connection) don't exist when the check starts.
      const ac = new AudioContext();
      await ac.resume().catch(() => {});
      const an = ac.createAnalyser();
      an.fftSize = 512;
      const buf = new Uint8Array(an.frequencyBinCount);
      let attached: MediaStream | null = null;
      let src: MediaStreamAudioSourceNode | null = null;
      const iv = setInterval(() => {
        const el = document.getElementById("rtc-remote-audio") as HTMLAudioElement | null;
        const ms = (el?.srcObject as MediaStream | null) ?? null;
        if (ms && ms !== attached && ms.getAudioTracks().length) {
          src?.disconnect();
          src = ac.createMediaStreamSource(ms);
          src.connect(an);
          attached = ms;
        }
        if (!attached) return;
        an.getByteTimeDomainData(buf);
        let p = 0;
        for (const v of buf) p = Math.max(p, Math.abs(v - 128));
        peak = Math.max(peak, p);
      }, 100);
      let sentMax = 0;
      const bytesIv = setInterval(() => {
        senderBytes().then((b) => (sentMax = Math.max(sentMax, b)), () => {});
      }, 500);
      stopMeter = () => {
        clearInterval(iv);
        clearInterval(bytesIv);
        ac.close().catch(() => {});
      };
      const sentBefore = await senderBytes();
      expectOutboundUntilRef.current = Date.now() + 20_000; // the check arrives as an incoming leg
      const res = await fetch("/api/line-check", { method: "POST" }).then((r) => r.json()); // ~10s: leg joins + speaks
      // Max seen DURING the check: a 46elks test leg hangs up when its clip ends, taking its pc with it.
      const sentAfter = Math.max(await senderBytes(), sentMax);
      stopMeter();
      const hear = !!res.ok && peak > 5; // harness-proven threshold (TTS peaks 20-60, floor ≤3)
      const send = sentAfter - sentBefore > 10_000; // ≥10kB opus over ~10s = mic genuinely flowing
      setLineCheck({ running: false, hear, hearRms: peak, send, sentKb: Math.round((sentAfter - sentBefore) / 1024) });
      flash(
        hear && send
          ? `✅ AUDIO VERIFIED — hear (RMS ${peak}) + mic (${Math.round((sentAfter - sentBefore) / 1024)}kB) — dial away`
          : `🔇 AUDIO CHECK FAILED — hear:${hear ? "✅" : `❌ rms ${peak}`} mic:${send ? "✅" : "❌"}${res.detail && !res.ok ? ` · ${res.detail}` : ""} — End line + Start line, then re-check`
      );
    } catch (e: any) {
      stopMeter();
      setLineCheck({ running: false, hear: false, send: false });
      flash(`🔇 line check error: ${e?.message || e}`);
    }
  }, [flash]);

  // Auto-verify audio once per session, right after the line goes live — before any lead is dialed.
  useEffect(() => {
    if (!sessionLive || session?.mode !== "rtc" || !(rtcRef.current.client || elksRtcRef.current.ua)) return;
    if (checkedSessionRef.current === session.id) return;
    checkedSessionRef.current = session.id;
    const t = setTimeout(() => runLineCheck(), 2500); // give the media leg a beat to settle
    return () => clearTimeout(t);
  }, [sessionLive, session, runLineCheck]);

  // DTMF keypad — navigate IVRs ("press 1 for sales") on the live lead leg
  const [dtmfSent, setDtmfSent] = useState("");
  const sendDtmf = useCallback(
    (digit: string) => {
      setDtmfSent((s) => (s + digit).slice(-12));
      api("/api/dtmf", { digits: digit }).catch(() => {});
    },
    [api]
  );

  const dialingRef = useRef(false);
  const dial = useCallback(() => {
    const l = leadRef.current;
    if (!l || dialingRef.current || callActiveRef.current) return; // never two calls at once
    dialingRef.current = true;
    cancelledDialRef.current = false;
    setDialing(true);
    setOutcome(null);
    setNotes("");
    setDtmfSent("");
    api("/api/call", { leadId: l.id })
      .catch(() => {})
      .finally(() => {
        dialingRef.current = false;
        setDialing(false);
      });
  }, [api]);

  // Ad-hoc dial: any number, queue or not. Server creates/reuses a minimal lead row so
  // wrapup, recording, and intel all work; the card swaps to it like the inbound path does.
  const [manualNumber, setManualNumber] = useState("");
  const manualDial = useCallback(() => {
    const n = manualNumber.trim();
    if (!n || dialingRef.current || callActiveRef.current) return;
    dialingRef.current = true;
    cancelledDialRef.current = false;
    setDialing(true);
    setOutcome(null);
    setNotes("");
    setDtmfSent("");
    api("/api/call", { number: n })
      .then((d) => {
        if (d.lead) setLead(d.lead);
        setManualNumber("");
      })
      .catch(() => {})
      .finally(() => {
        dialingRef.current = false;
        setDialing(false);
      });
  }, [api, manualNumber]);
  const hangup = useCallback(() => {
    const sessions = new Set(elksSessionsRef.current);
    if (elksRtcRef.current.session) sessions.add(elksRtcRef.current.session);
    for (const elksSess of sessions) {
      try {
        elksSess.terminate();
      } catch {}
    }
    elksSessionsRef.current.clear();
    elksRtcRef.current.session = null;
    // A hang up during an in-flight dial still reaches the server, which cancels that leg on return.
    if (dialingRef.current) cancelledDialRef.current = true;
    api("/api/hangup").catch(() => {});
  }, [api]);

  const sendBooking = useCallback(() => {
    const l = leadRef.current;
    if (!l) return;
    if (!l.email) return flash("⚠ no email on this lead");
    api("/api/send-booking", { leadId: l.id })
      .then((d) => flash(`📅 booking link sent → ${d.to}`))
      .catch(() => {});
  }, [api, flash]);

  /** Audio-path test: dials your own number so you can answer and confirm two-way audio. */
  const testCall = useCallback(() => {
    api("/api/test-call", {})
      .then((d) => flash(`📞 test call ringing ${d.to} — answer it to check audio`))
      .catch((e: any) => setError(e?.message || "Test call failed"));
  }, [api, flash]);

  /**
   * End-to-end self test on the browser line: a real lead-style dial to the operator's own mobile.
   * Answer it and talk — phone ↔ browser proves both directions over the exact path a prospect takes.
   */
  const callMyPhone = useCallback(() => {
    if (!operatorPhone) {
      setError("Set your mobile number first (OPERATOR_PHONE)");
      return;
    }
    setOutcome(null);
    setNotes("");
    setDtmfSent("");
    api("/api/test-call", { number: operatorPhone })
      .then((d) => {
        if (d.lead) setLead(d.lead);
        flash(`📱 ringing ${d.to} — answer and talk: you should hear yourself in the browser and vice versa`);
      })
      .catch((e: any) => setError(e?.message || "Test call failed"));
  }, [api, flash, operatorPhone]);

  const saveOutcome = useCallback(
    (skip = false) => {
      const l = leadRef.current;
      if (!l || (!skip && !outcome)) return;
      setBusy(true);
      const country = regionRef.current || undefined;
      const source = sourceRef.current || undefined;
      api("/api/outcome", skip ? { leadId: l.id, skip: true, country, source } : { leadId: l.id, outcome, notes, country, source })
        .then((d) => {
          setLead(d.currentLead);
          setQueue(d.queue);
          setCounts(d.counts);
          setOutcome(null);
          setNotes("");
          setCall(null);
          notesRef.current?.blur();
        })
        .catch(() => {})
        .finally(() => setBusy(false));
    },
    [api, outcome, notes]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement?.tagName === "TEXTAREA" || document.activeElement?.tagName === "INPUT";
      if (typing) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          saveOutcome();
        }
        if (e.key === "Escape") (document.activeElement as HTMLElement).blur();
        return;
      }
      // Never hijack browser shortcuts (Ctrl/Cmd+C copy, +V paste, etc.)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // While the call is live, digit keys are DTMF for IVR menus — outcome keys
      // (1–5) take over again after hangup, in wrapup.
      if (callActive && callStatus === "answered" && /^[0-9*#]$/.test(e.key)) {
        sendDtmf(e.key);
        e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "p" && !callActive) dial();
      else if (k === "h" && callActive) hangup();
      else if (k === "s") saveOutcome(true);
      else if (k === "u") undo();
      else if (k === "b") sendBooking();
      else if (k === "o") {
        const u = fullUrl(leadRef.current?.website ?? null);
        if (u) window.open(u, "_blank");
      } else if (k === "l") {
        if (leadRef.current?.linkedin) window.open(leadRef.current.linkedin, "_blank");
      } else if (k === "n") {
        notesRef.current?.focus();
        e.preventDefault();
      } else if (e.key === "Enter") saveOutcome();
      else {
        const o = OUTCOMES.find((x) => x.key === e.key);
        if (o) {
          setOutcome(o.value);
          notesRef.current?.focus();
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [callActive, callStatus, dial, hangup, saveOutcome, undo, sendBooking, sendDtmf]);

  const statusChip = (() => {
    if (!callActive) return null;
    const map: Record<string, [string, string]> = {
      started: ["Dialing…", "text-zinc-400"],
      ringing: ["Ringing…", "text-amber-400 animate-pulse"],
      answered: [`Live ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`, "text-emerald-400"],
    };
    const [label, cls] = map[callStatus ?? "started"] ?? [callStatus ?? "…", "text-zinc-400"];
    return <span className={`text-sm font-medium tabular-nums ${cls}`}>{label}</span>;
  })();

  const website = fullUrl(lead?.website ?? null);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-[family-name:var(--font-geist-sans)]">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-zinc-800 px-5 py-3 text-sm">
        <span className="font-semibold tracking-tight">RapidDial</span>
        <span className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              connDead
                ? "bg-red-500 animate-pulse"
                : sessionLive
                  ? lineCheck && !lineCheck.running && lineCheck.hear && lineCheck.send
                    ? "bg-emerald-400"
                    : "bg-amber-400"
                  : session?.status === "starting"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-zinc-600"
            }`}
          />
          <span className="text-zinc-400">
            {connDead
              ? "LINE DEAD"
              : sessionLive
                ? `Line live ${provider === "46elks" ? "· 🇸🇪 46elks" : session?.mode === "rtc" ? "· 🎧 browser" : "· 📱 phone"}`
                : session?.status === "starting"
                  ? session?.mode === "rtc"
                    ? "Connecting browser line…"
                    : "Answer your phone…"
                  : "Line down"}
          </span>
        </span>
        {session?.mode === "rtc" && lineCheck && (
          <span
            title="Audio self-check: 🔊 you can hear the room · 🎤 your mic reaches the room"
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              lineCheck.running
                ? "bg-zinc-800 text-zinc-300 animate-pulse"
                : lineCheck.hear && lineCheck.send
                  ? "bg-emerald-950 text-emerald-300"
                  : "bg-red-950 text-red-300"
            }`}
          >
            {lineCheck.running
              ? "🔎 audio check…"
              : `🔊${lineCheck.hear ? "✅" : "❌"} 🎤${lineCheck.send ? "✅" : "❌"}`}
          </span>
        )}
        {sessionLive && session?.mode === "rtc" && !callActive && !lineCheck?.running && (
          <button
            onClick={runLineCheck}
            title="Re-verify two-way audio (dials a 10s TTS leg into the room)"
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-900"
          >
            ↻ audio
          </button>
        )}
        {session ? (
          <>
            <button onClick={endLine} className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-900">
              End line
            </button>
            {sessionLive && !callActive && (
              <button
                onClick={testCall}
                title={
                  provider === "46elks"
                    ? "Rings your mobile, then bridges to a test number"
                    : "Dials a test number so you can answer and verify two-way audio"
                }
                className="rounded border border-sky-700 px-2.5 py-1 text-sky-300 hover:bg-sky-950"
              >
                📞 Test audio
              </button>
            )}
            {sessionLive && !callActive && session?.mode === "rtc" && provider === "46elks" && (
              <button
                onClick={callMyPhone}
                title={`Calls your mobile ${operatorPhone || ""} through the browser line — answer and talk to check both directions`}
                className="rounded border border-emerald-700 px-2.5 py-1 text-emerald-300 hover:bg-emerald-950"
              >
                📱 Call my phone
              </button>
            )}
          </>
        ) : (
          <>
            <button
              onClick={startBrowserLine}
              className="rounded border border-emerald-700 px-2.5 py-1 text-emerald-300 hover:bg-emerald-950"
            >
              🎧 Start line (browser)
            </button>
            {provider === "vonage" && (
              <button onClick={startLine} className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-400 hover:bg-zinc-900">
                📱 phone
              </button>
            )}
            {provider === "46elks" && (
              <button
                onClick={startLine}
                title="Rings your mobile first — needs a working phone"
                className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-500 hover:bg-zinc-900"
              >
                📱 phone (46elks)
              </button>
            )}
          </>
        )}
        <select
          value={provider}
          onChange={(e) => switchProvider(e.target.value as "vonage" | "46elks")}
          title="Telephony provider"
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300 focus:outline-none"
        >
          <option value="vonage">Vonage</option>
          <option value="46elks">46elks 🇸🇪</option>
        </select>
        <select
          value={region}
          onChange={(e) => changeRegion(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300 focus:outline-none"
        >
          <option value="">🌍 All countries</option>
          {countries.map((c) => (
            <option key={c.country} value={c.country}>
              {c.country} ({c.n})
            </option>
          ))}
        </select>
        {sources.length > 0 && (
          <select
            value={source}
            onChange={(e) => changeSource(e.target.value)}
            title="Filter the queue to one import batch — most recent first (🆕)"
            className="max-w-[230px] truncate rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300 focus:outline-none"
          >
            <option value="">📂 All sources</option>
            {sources.map((s, i) => (
              <option key={s.source} value={s.source}>
                {i === 0 ? "🆕 " : ""}{s.source.replace(/\.csv$/, "")} ({s.n})
              </option>
            ))}
          </select>
        )}
        {micDevices.length > 0 && (
          <select
            value={micDeviceId}
            onChange={(e) => selectMic(e.target.value)}
            title="Microphone for the call (applies to a live call after End + Start line)"
            className="max-w-[150px] truncate rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300 focus:outline-none"
          >
            <option value="">🎤 Default mic</option>
            {micDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>🎤 {d.label}</option>
            ))}
          </select>
        )}
        {outputDevices.length > 0 && (
          <select
            value={outputDeviceId}
            onChange={(e) => selectOutput(e.target.value)}
            title="Speaker/headset the call audio plays to (applies immediately)"
            className="max-w-[150px] truncate rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300 focus:outline-none"
          >
            <option value="">🔊 Default speaker</option>
            {outputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>🔊 {d.label}</option>
            ))}
          </select>
        )}
        <button
          onClick={testOutput}
          title="Play a test tone through the chosen speaker"
          className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-900"
        >
          🔊 test
        </button>
        <span className="ml-auto flex items-center gap-4 text-zinc-500">
          <button
            type="button"
            onClick={async () => {
              // cycle: auto → US → SE → auto
              const next = callerOverride === null ? "US" : callerOverride === "US" ? "SE" : "auto";
              await fetch("/api/callerid", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ region: next }),
              });
              await refresh();
              flash(next === "auto" ? "Caller ID: Auto (matches lead country)" : `Caller ID forced: ${next}`);
            }}
            title="Click to toggle caller ID: Auto (by lead country) → US → SE"
            className={`rounded px-2 py-0.5 font-mono ${callerOverride ? "bg-amber-900/50 text-amber-300" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {callerRegion === "US" ? "🇺🇸" : "🇸🇪"} CID {callerId}
            {callerOverride ? " 🔒" : " ·auto"}
          </button>
          {balance !== null && (
            <span className={balance < (balanceCurrency === "SEK" ? 5 : 1) ? "text-red-400" : ""}>
              {balanceCurrency === "SEK" ? `${balance.toFixed(2)} kr` : `€${balance.toFixed(2)}`}
            </span>
          )}
          <span>{counts.callsToday} calls today</span>
          <span>{counts.queued} queued</span>
          {provider === "46elks" && (
            <button
              type="button"
              onClick={() => {
                setSmsOpen((o) => !o);
                refreshSmsInbox();
                refreshVerifyInbox();
              }}
              title="Texts + OTP inbox on +46766861525"
              className="rounded border border-sky-800 px-2 py-0.5 text-sky-300 hover:bg-sky-950"
            >
              💬 SMS {smsInbox.length + verifyInbox.length > 0 ? `(${smsInbox.length + verifyInbox.length})` : ""}
              {verifyRinging ? " 📞" : ""}
            </button>
          )}
          <UploadButton onDone={refresh} />
        </span>
      </header>

      {(ready || error) && (
        <div className="border-b border-red-900 bg-red-950/60 px-5 py-2 text-sm text-red-300">{error || ready}</div>
      )}

      {provider === "46elks" && smsOpen && (
        <div className="border-b border-zinc-800 bg-zinc-900/90 px-5 py-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-zinc-300">
              OTP inbox · <span className="font-mono text-sky-300">+46766861525</span>
              {verifyRinging ? (
                <span className="ml-2 animate-pulse text-amber-300">— verification call ringing…</span>
              ) : verifyMode === "missed" ? (
                <span className="ml-2 text-emerald-300">— missed-call mode (no answer · CLI digits)</span>
              ) : verifyMode === "listen" ? (
                <span className="ml-2 text-amber-200/80">— voice OTP mode (answers + records)</span>
              ) : (
                <span className="ml-2 text-zinc-500">— verify capture {verifyMode}</span>
              )}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void setVerifyModeApi("missed")}
                title="Meta Missed call: reject immediately, OTP = last digits of caller ID"
                className={
                  "rounded border px-2 py-0.5 text-xs " +
                  (verifyMode === "missed"
                    ? "border-emerald-600 bg-emerald-950 text-emerald-200"
                    : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")
                }
              >
                📵 Missed
              </button>
              <button
                type="button"
                onClick={() => void setVerifyModeApi("listen")}
                title="Meta Voice call: answer, record spoken OTP"
                className={
                  "rounded border px-2 py-0.5 text-xs " +
                  (verifyMode === "listen"
                    ? "border-amber-600 bg-amber-950 text-amber-200"
                    : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")
                }
              >
                🎙 Voice
              </button>
              <button
                type="button"
                onClick={() => void setVerifyModeApi("off")}
                title="Disable verify capture"
                className={
                  "rounded border px-2 py-0.5 text-xs " +
                  (verifyMode === "off"
                    ? "border-zinc-500 bg-zinc-800 text-zinc-200"
                    : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")
                }
              >
                Off
              </button>
              <button
                type="button"
                onClick={() => {
                  refreshSmsInbox();
                  refreshVerifyInbox();
                }}
                className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                ↻ refresh
              </button>
            </div>
          </div>
          {verifyInbox.length > 0 && (
            <div className="mb-3 space-y-2">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                {verifyMode === "missed" ? "Missed-call OTP (CLI last digits)" : "Voice / missed OTP"}
              </p>
              {verifyInbox.map((v) => {
                const isMissed = (v.transcript || "").startsWith("Missed-call") || (v.id || "").startsWith("missed-");
                const candidates =
                  v.transcript?.match(/\b(\d{4,6})(?:\s*\/\s*(\d{4,6}))?(?:\s*\/\s*(\d{4,6}))?\b/g) ||
                  (v.code ? [v.code] : []);
                // Prefer explicit last-digit list after "try last digits:"
                const after = v.transcript?.split("try last digits:")[1];
                const fromLine = after
                  ? after
                      .split("/")
                      .map((s) => s.trim().replace(/\D/g, ""))
                      .filter((s) => s.length >= 4 && s.length <= 6)
                  : [];
                const codes = fromLine.length ? fromLine : candidates.length ? candidates : v.code ? [v.code] : [];
                return (
                  <div
                    key={v.id}
                    className={
                      "rounded border px-3 py-2 text-sm " +
                      (isMissed
                        ? "border-emerald-900/60 bg-emerald-950/25"
                        : "border-amber-900/60 bg-amber-950/30")
                    }
                  >
                    {v.code ? (
                      <div
                        className={
                          "cursor-pointer font-mono text-2xl tracking-widest " +
                          (isMissed ? "text-emerald-200" : "text-amber-200")
                        }
                        onClick={() => {
                          navigator.clipboard.writeText(v.code!).then(() => flash(`Copied OTP ${v.code}`));
                        }}
                        title="Click to copy primary OTP"
                      >
                        {v.code}
                      </div>
                    ) : (
                      <div className="text-amber-100/90">{v.transcript || "Waiting…"}</div>
                    )}
                    {codes.length > 1 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {codes.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(c).then(() => flash(`Copied ${c}`));
                            }}
                            className="rounded border border-emerald-800/80 bg-emerald-950/50 px-2 py-0.5 font-mono text-sm text-emerald-200 hover:border-emerald-500"
                            title={`Copy candidate ${c}`}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-zinc-500">
                      {isMissed && <span className="mr-1 text-emerald-500">missed · </span>}
                      {v.from_e164 && <span className="font-mono">{v.from_e164} · </span>}
                      {v.received_at}
                      {v.transcript && v.code && (
                        <span className="ml-1 text-zinc-600">· {v.transcript}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <form
            className="mb-2 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void sendSmsNow();
            }}
          >
            <input
              value={smsTo}
              onChange={(e) => setSmsTo(e.target.value)}
              placeholder={lead?.phone_e164 ? `To ${lead.phone_e164} (current lead)` : "To +46… / 07x…"}
              className="w-48 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-200"
            />
            <input
              value={smsBody}
              onChange={(e) => setSmsBody(e.target.value)}
              placeholder="Text message…"
              maxLength={1600}
              className="min-w-[12rem] flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
            />
            <span className="text-xs text-zinc-500">{smsBody.length > 160 ? `${Math.ceil(smsBody.length / 153)} parts` : ""}</span>
            <button
              type="submit"
              disabled={smsSending || !smsBody.trim()}
              className="rounded border border-sky-700 px-3 py-1 text-sm text-sky-200 hover:bg-sky-950 disabled:opacity-40"
            >
              {smsSending ? "Sending…" : "Send"}
            </button>
          </form>
          <div className="max-h-36 space-y-2 overflow-y-auto">
            {smsInbox.length === 0 ? (
              <p className="text-sm text-zinc-500">
                {verifyMode === "missed"
                  ? "No SMS yet — for Missed call, wait for Meta to ring then use CLI digits above"
                  : "No SMS yet — Meta usually cannot SMS VoIP numbers"}
              </p>
            ) : (
              smsInbox.map((m) => (
                <div
                  key={m.id}
                  className="cursor-pointer rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm hover:border-zinc-600"
                  onClick={() => {
                    const code = m.message?.match(/\d{6}/)?.[0];
                    const copy = code || m.message || "";
                    navigator.clipboard.writeText(copy).then(() => flash(code ? `Copied OTP ${code}` : "Copied message"));
                  }}
                  title="Click to copy OTP or full message"
                >
                  <div className="flex justify-between gap-2 text-xs text-zinc-500">
                    {(m.from_e164 || "").replace(/\D/g, "") === "46766861525" ? (
                      <span className="font-mono text-sky-400">→ {m.to_e164} (sent)</span>
                    ) : (
                      <span className="font-mono">
                        {m.from_e164}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSmsTo(m.from_e164 || "");
                          }}
                          className="ml-2 text-sky-400 hover:underline"
                        >
                          reply
                        </button>
                      </span>
                    )}
                    <span>{m.received_at}</span>
                  </div>
                  <p className="mt-1 text-zinc-200">
                    {(m.message || "").split(/(\d{6})/).map((part, i) =>
                      /^\d{6}$/.test(part) ? (
                        <span key={i} className="rounded bg-emerald-950 px-1.5 py-0.5 font-bold text-emerald-300">
                          {part}
                        </span>
                      ) : (
                        <span key={i}>{part}</span>
                      )
                    )}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      {connDead && session?.mode === "rtc" && (
        <div className="border-b border-red-900 bg-red-950/80 px-5 py-2 text-sm font-medium text-red-200">
          🔇 Browser line media is DEAD — calls will be silent. Click <b>End line</b>, then <b>🎧 Start line</b>. The
          audio check will re-verify automatically.
        </div>
      )}
      {toast && (
        <div className="border-b border-sky-900 bg-sky-950/60 px-5 py-2 text-sm text-sky-200">{toast}</div>
      )}
      {ringing && (
        <div className="flex items-center gap-3 border-b border-emerald-600 bg-emerald-900/70 px-5 py-3 text-sm">
          <span className="animate-pulse text-lg">📞</span>
          <span className="font-semibold text-emerald-50">
            Incoming call <span className="ml-1 font-mono text-emerald-300">{ringing.from}</span>
            {inbound?.lead && <span className="ml-2 font-normal text-emerald-200">— {inbound.lead.company}</span>}
          </span>
          <button
            onClick={answerInbound}
            className="ml-auto rounded bg-emerald-500 px-4 py-1.5 font-semibold text-emerald-950 hover:bg-emerald-400"
          >
            Answer
          </button>
          <button
            onClick={declineInbound}
            className="rounded border border-red-700 px-3 py-1.5 text-red-300 hover:bg-red-950"
          >
            Decline
          </button>
        </div>
      )}
      {inbound && (
        <div className="flex items-center gap-3 border-b border-emerald-800 bg-emerald-950/60 px-5 py-2.5 text-sm">
          <span className="animate-pulse text-base">📲</span>
          {inbound.lead ? (
            <span className="text-emerald-100">
              <span className="font-semibold">
                INBOUND: {`${inbound.lead.first_name ?? ""} ${inbound.lead.last_name ?? ""}`.trim() || "Unknown contact"}
              </span>
              <span className="text-emerald-300"> — {inbound.lead.company}</span>
              <span className="ml-2 font-mono text-emerald-400">{inbound.from}</span>
              {inbound.stats && (
                <span className="ml-2 text-emerald-300/80">
                  · {inbound.stats.calls} prior call{inbound.stats.calls === 1 ? "" : "s"}
                  {inbound.stats.talk_s > 0 && ` · ${Math.round(inbound.stats.talk_s / 60)}m talk`}
                  {inbound.stats.last_outcome && ` · last: ${inbound.stats.last_outcome.replace("_", " ")}`}
                  {inbound.stats.last_at && ` (${inbound.stats.last_at.slice(0, 10)})`}
                </span>
              )}
            </span>
          ) : (
            <span className="text-emerald-100">
              <span className="font-semibold">INBOUND:</span>
              <span className="ml-2 font-mono text-emerald-400">{inbound.from}</span>
              <span className="ml-2 text-emerald-300/80">— not in lead list</span>
            </span>
          )}
          <button
            onClick={() => setInbound(null)}
            className="ml-auto rounded border border-emerald-800 px-2 py-0.5 text-emerald-300 hover:bg-emerald-900"
          >
            ✕
          </button>
        </div>
      )}
      {(session?.mode === "rtc" || micActive) && (
        <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/40 px-5 py-2 text-xs text-zinc-400">
          <span>🎤 mic</span>
          <span className="inline-block h-2 w-40 overflow-hidden rounded bg-zinc-800">
            <span className="block h-full bg-emerald-500 transition-[width] duration-75" style={{ width: `${micLevel}%` }} />
          </span>
          <span className="w-8 tabular-nums">{micLevel}%</span>
          <span className="text-zinc-700">|</span>
          <span>{rtcDiag || (session?.mode === "rtc" ? "starting line…" : "🎤 mic live — speak to test")}</span>
          <span className="ml-auto text-zinc-600">speak to test mic · stuck? open chrome://webrtc-internals</span>
        </div>
      )}

      <main className="grid grid-cols-[1fr_280px] gap-0">
        {/* Lead card + call controls */}
        <section className="flex min-h-[calc(100vh-49px)] flex-col gap-4 p-6">
          {/* Manual dial — call any number, queue or not */}
          <div className="flex items-center gap-2">
            <input
              value={manualNumber}
              onChange={(e) => setManualNumber(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // keep global hotkeys (Enter→saveOutcome, P→dial) out of this field
                if (e.key === "Enter") {
                  e.preventDefault();
                  manualDial();
                }
                if (e.key === "Escape") (e.target as HTMLElement).blur();
              }}
              placeholder="Dial any number… +46 / 07x / +1"
              className="w-60 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
            <button
              onClick={manualDial}
              disabled={!sessionLive || callActive || !manualNumber.trim()}
              className="rounded border border-emerald-800 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-950 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
              title={sessionLive ? "Dial this number into the live line" : "Start the line first"}
            >
              ☎ Call number
            </button>
          </div>
          {lead ? (
            <>
              <div>
                <div className="flex items-baseline gap-3">
                  <h1 className="text-3xl font-semibold tracking-tight">{lead.company}</h1>
                  {lead.priority === 0 && (
                    <span className="rounded bg-sky-950 px-2 py-0.5 text-xs font-medium text-sky-300">CALLBACK DUE</span>
                  )}
                </div>
                <p className="mt-1 text-zinc-400">
                  {[`${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(), lead.title].filter(Boolean).join(" — ") || "No contact name"}
                </p>
                <p className="mt-2 font-mono text-lg text-zinc-200">{lead.phone_e164}</p>
                <p className="mt-1 text-sm text-zinc-500">
                  {[lead.email, lead.city, lead.country, lead.industry, lead.employees && `${lead.employees} ppl`]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="mt-3 flex gap-2 text-sm">
                  {website && (
                    <a href={website} target="_blank" className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-900">
                      Website ↗ <kbd className="text-zinc-600">O</kbd>
                    </a>
                  )}
                  {lead.linkedin && (
                    <a href={lead.linkedin} target="_blank" className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-900">
                      LinkedIn ↗ <kbd className="text-zinc-600">L</kbd>
                    </a>
                  )}
                </div>
              </div>

              {lead.prior_notes && (
                <div className="whitespace-pre-wrap rounded-md border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-200">
                  {lead.prior_notes}
                </div>
              )}

              {/* Call bar */}
              <div className="flex items-center gap-4 rounded-md border border-zinc-800 bg-zinc-900/60 p-4">
                {!callActive ? (
                  <button
                    onClick={dial}
                    disabled={!sessionLive}
                    className="rounded-md bg-emerald-600 px-8 py-3 text-lg font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                  >
                    Call <kbd className="ml-1 text-emerald-200/70">P</kbd>
                  </button>
                ) : (
                  <button onClick={hangup} className="rounded-md bg-red-700 px-8 py-3 text-lg font-semibold text-white hover:bg-red-600">
                    Hang up <kbd className="ml-1 text-red-200/70">H</kbd>
                  </button>
                )}
                {statusChip}
                <button
                  onClick={sendBooking}
                  disabled={!lead.email}
                  className="rounded border border-sky-800 px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-950 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
                  title={lead.email ? `Email ${lead.email} your booking link` : "Lead has no email"}
                >
                  📅 Send booking <kbd className="text-zinc-600">B</kbd>
                </button>
                {!sessionLive && !callActive && <span className="text-sm text-zinc-500">Start the line first ↑</span>}
                {inWrapup && <span className="text-sm text-zinc-400">Call ended — log the outcome ↓</span>}
                {callActive && (
                  <div className="ml-auto flex items-center gap-3">
                    {dtmfSent && <span className="font-mono text-sm text-zinc-500">{dtmfSent}</span>}
                    <div className="grid grid-cols-3 gap-1" title="IVR keypad — or just type 0-9 * # while the call is live">
                      {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((d) => (
                        <button
                          key={d}
                          onClick={() => sendDtmf(d)}
                          disabled={callStatus !== "answered"}
                          className="h-8 w-8 rounded border border-zinc-700 font-mono text-sm text-zinc-300 hover:bg-zinc-800 active:bg-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-700"
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Last call intel (Whisper + GPT, lands ~20s after each hangup) */}
              {intel?.analysis && !intel.analysis.error && (
                <div className="rounded-md border border-indigo-900/60 bg-indigo-950/30 p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-indigo-400">
                    Last call intel
                    {intel.analysis.interest != null && <span>· interest {intel.analysis.interest}/5</span>}
                  </div>
                  <p className="text-indigo-100">{intel.analysis.summary}</p>
                  {intel.analysis.action_items?.length > 0 && (
                    <ul className="mt-1.5 list-inside list-disc text-indigo-200">
                      {intel.analysis.action_items.map((a: string, i: number) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Wrapup */}
              <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="flex flex-wrap gap-2">
                  {OUTCOMES.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => setOutcome(o.value)}
                      className={`rounded border px-3 py-1.5 text-sm ${o.cls} ${outcome === o.value ? "bg-zinc-800 ring-1 ring-zinc-500" : "hover:bg-zinc-900"}`}
                    >
                      <kbd className="mr-1.5 text-zinc-600">{o.key}</kbd>
                      {o.label}
                    </button>
                  ))}
                  <button
                    onClick={() => saveOutcome(true)}
                    className="ml-auto rounded border border-zinc-800 px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-900"
                  >
                    <kbd className="mr-1.5 text-zinc-600">S</kbd>Skip
                  </button>
                </div>
                <div className="mt-3 flex gap-2">
                  <textarea
                    ref={notesRef}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notes… (N to focus, Enter to save + next)"
                    rows={2}
                    className="flex-1 resize-none rounded border border-zinc-800 bg-zinc-950 p-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                  />
                  <button
                    onClick={() => saveOutcome()}
                    disabled={!outcome || busy}
                    className="rounded-md bg-zinc-100 px-5 font-medium text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-600"
                  >
                    Save + Next ⏎
                  </button>
                </div>
              </div>

              {/* Website preview */}
              {website &&
                (embeddable ? (
                  <iframe src={website} className="min-h-[320px] flex-1 rounded-md border border-zinc-800 bg-white" sandbox="allow-scripts allow-same-origin" />
                ) : (
                  <div className="flex min-h-[120px] flex-1 items-center justify-center rounded-md border border-dashed border-zinc-800 text-sm text-zinc-600">
                    Site blocks embedding —&nbsp;
                    <a href={website} target="_blank" className="text-zinc-400 underline hover:text-zinc-200">
                      open {lead.website} ↗
                    </a>
                  </div>
                ))}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-zinc-600">Queue empty — import more leads.</div>
          )}
        </section>

        {/* Queue sidebar */}
        <aside className="border-l border-zinc-800 p-4">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">Up next</h2>
          <ul className="space-y-1.5">
            {queue.map((q, i) => (
              <li
                key={q.id}
                className={`rounded px-2 py-1.5 text-sm ${i === 0 ? "bg-zinc-900 text-zinc-100" : "text-zinc-500"}`}
              >
                <span className="block truncate">
                  {q.priority === 0 && <span className="mr-1 text-sky-400">↩</span>}
                  {q.company}
                </span>
                <span className="block truncate text-xs text-zinc-600">
                  {`${q.first_name ?? ""} ${q.last_name ?? ""}`.trim() || q.city || q.phone_e164}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
}

function UploadButton({ onDone }: { onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const fd = new FormData();
          fd.append("file", f);
          const res = await fetch("/api/leads/import", { method: "POST", body: fd }).then((r) => r.json());
          setMsg(res.error ?? `+${res.inserted} leads`);
          setTimeout(() => setMsg(null), 4000);
          e.target.value = "";
          onDone();
        }}
      />
      <button onClick={() => inputRef.current?.click()} className="rounded border border-zinc-800 px-2 py-1 text-zinc-400 hover:bg-zinc-900">
        {msg ?? "Import CSV"}
      </button>
    </>
  );
}
