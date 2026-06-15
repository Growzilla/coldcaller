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
    if (id && constraints.audio) {
      const base = typeof constraints.audio === "object" ? constraints.audio : {};
      constraints = { ...constraints, audio: { ...base, deviceId: { exact: id } } };
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
  const [toast, setToast] = useState<string | null>(null);
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

  const callActive = !!call && !call.ended_at;
  const callStatus = call?.vonage_status ?? null;
  const callActiveRef = useRef(false);
  callActiveRef.current = callActive;
  const inWrapup = !!call && !!call.ended_at && call.lead_id === lead?.id && !busy;
  const sessionLive = session?.status === "live";

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
    const savedSource = localStorage.getItem("dialer-source") ?? "";
    sourceRef.current = savedSource;
    setSource(savedSource);
    refresh();
  }, [refresh]);

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
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
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

  const startLine = useCallback(() => api("/api/session/start", { mode: "phone" }).catch(() => {}), [api]);

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
      setConnDead(cs === "failed" || cs === "closed"); // media liveness — the dot must not lie
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
      let peak = 0;
      const el = document.getElementById("rtc-remote-audio") as HTMLAudioElement | null;
      const ms = (el?.srcObject as MediaStream | null) ?? null;
      if (ms?.getAudioTracks().length) {
        const ac = new AudioContext();
        await ac.resume().catch(() => {});
        const an = ac.createAnalyser();
        an.fftSize = 512;
        ac.createMediaStreamSource(ms).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const iv = setInterval(() => {
          an.getByteTimeDomainData(buf);
          let p = 0;
          for (const v of buf) p = Math.max(p, Math.abs(v - 128));
          peak = Math.max(peak, p);
        }, 100);
        stopMeter = () => {
          clearInterval(iv);
          ac.close().catch(() => {});
        };
      }
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
      const sentBefore = await senderBytes();
      const res = await fetch("/api/line-check", { method: "POST" }).then((r) => r.json()); // ~10s: leg joins + speaks
      const sentAfter = await senderBytes();
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
    if (!sessionLive || session?.mode !== "rtc" || !rtcRef.current.client) return;
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

  const dial = useCallback(() => {
    const l = leadRef.current;
    if (!l) return;
    setOutcome(null);
    setNotes("");
    setDtmfSent("");
    api("/api/call", { leadId: l.id }).catch(() => {});
  }, [api]);

  // Ad-hoc dial: any number, queue or not. Server creates/reuses a minimal lead row so
  // wrapup, recording, and intel all work; the card swaps to it like the inbound path does.
  const [manualNumber, setManualNumber] = useState("");
  const manualDial = useCallback(() => {
    const n = manualNumber.trim();
    if (!n) return;
    setOutcome(null);
    setNotes("");
    setDtmfSent("");
    api("/api/call", { number: n })
      .then((d) => {
        if (d.lead) setLead(d.lead);
        setManualNumber("");
      })
      .catch(() => {});
  }, [api, manualNumber]);
  const hangup = useCallback(() => api("/api/hangup").catch(() => {}), [api]);

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
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 px-5 py-3 text-sm">
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
                ? `Line live ${session?.mode === "rtc" ? "· 🎧 browser" : "· 📱 phone"}`
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
                title="Dials +66838840280 so you can answer and verify two-way audio"
                className="rounded border border-sky-700 px-2.5 py-1 text-sky-300 hover:bg-sky-950"
              >
                📞 Test audio
              </button>
            )}
          </>
        ) : (
          <>
            <button onClick={startLineRtc} className="rounded border border-emerald-700 px-2.5 py-1 text-emerald-300 hover:bg-emerald-950">
              🎧 Start line (browser)
            </button>
            <button onClick={startLine} className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-400 hover:bg-zinc-900">
              📱 phone
            </button>
          </>
        )}
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
          {balance !== null && <span className={balance < 1 ? "text-red-400" : ""}>€{balance.toFixed(2)}</span>}
          <span>{counts.callsToday} calls today</span>
          <span>{counts.queued} queued</span>
          <UploadButton onDone={refresh} />
        </span>
      </header>

      {(ready || error) && (
        <div className="border-b border-red-900 bg-red-950/60 px-5 py-2 text-sm text-red-300">{error || ready}</div>
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

      <main className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-0">
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
        <aside className="border-t border-zinc-800 p-4 md:border-l md:border-t-0">
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
