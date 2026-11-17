"use client";

/**
 * Per-call browser recorder: mixes the mic with every playing <audio> element
 * (the Vonage Client SDK plays the remote party through one) into a single
 * opus/webm stream. One file per lead call, uploaded on stop.
 */

let ctx: AudioContext | null = null;
let recorder: MediaRecorder | null = null;
let micStream: MediaStream | null = null;
let chunks: Blob[] = [];
/** Clones only. Stopping the sender's own track would mute the lead. */
let owned: MediaStreamTrack[] = [];

/**
 * Web Audio must not attach to the track Twilio is sending. On this machine that
 * tap makes the lead hear chopped, quiet audio. A clone keeps the sender direct.
 */
function cloned(t: MediaStreamTrack): MediaStreamTrack | null {
  if (t.kind !== "audio" || t.readyState !== "live" || typeof t.clone !== "function") return null;
  const copy = t.clone();
  owned.push(copy);
  return copy;
}

function releaseClones(): void {
  for (const t of owned) {
    try { t.stop(); } catch { /* clone already ended */ }
  }
  owned = [];
  micStream = null;
}

export async function startCallRecording(): Promise<void> {
  if (recorder) return; // already rolling
  // The call already holds the mic. Opening another getUserMedia here is a second
  // echo-cancelled capture, and Chrome then silences the outbound audio.
  const sdkTrack = (window as any).__sdkMicTrack as MediaStreamTrack | undefined;
  const liveMic = sdkTrack && sdkTrack.kind === "audio" && sdkTrack.readyState === "live" ? cloned(sdkTrack) : null;
  micStream = liveMic ? new MediaStream([liveMic]) : null;
  try {
    try {
      ctx = new AudioContext({ sampleRate: 48000 });
    } catch {
      ctx = new AudioContext();
    }
    ctx.resume().catch(() => {});
    const mix = ctx.createMediaStreamDestination();
    if (micStream) ctx.createMediaStreamSource(micStream).connect(mix);

  // Remote (prospect) audio. Primary source: the raw WebRTC tracks stashed by the
  // RTCPeerConnection patch in page.tsx — immune to <audio> srcObject swaps that made
  // recordings one-sided (every pre-2026-06-12 recording lacked the prospect's voice).
  // Tracks are deduped by id; late tracks (renegotiation mid-call) join via __recorderAddTrack.
  const seen = new Set<string>();
  const addTrack = (t: MediaStreamTrack) => {
    if (!ctx || t.kind !== "audio" || t.readyState !== "live" || seen.has(t.id)) return;
    const copy = cloned(t);
    if (!copy) return;
    seen.add(t.id);
    try {
      ctx.createMediaStreamSource(new MediaStream([copy])).connect(mix);
    } catch {
      /* track not capturable — keep going with what we have */
    }
  };
  for (const t of ((window as any).__rtcRemoteTracks as MediaStreamTrack[] | undefined) ?? []) addTrack(t);
  (window as any).__recorderAddTrack = addTrack;

  // Fallback: anything already playing through an <audio> element (covers a missed patch).
  for (const el of Array.from(document.querySelectorAll("audio"))) {
    try {
      const remote =
        (el as any).srcObject instanceof MediaStream
          ? ((el as any).srcObject as MediaStream)
          : (el as any).captureStream?.();
      remote?.getAudioTracks().forEach(addTrack);
    } catch {
      /* element not capturable — keep going with what we have */
    }
  }

    chunks = [];
    recorder = new MediaRecorder(mix.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start(1000);
  } catch (e) {
    releaseClones();
    ctx?.close().catch(() => {});
    ctx = null;
    recorder = null;
    throw e;
  }
}

/** Stop and upload to the call's audio endpoint. Resolves once the upload is sent. */
export async function stopCallRecording(callId: number): Promise<void> {
  const r = recorder;
  recorder = null;
  delete (window as any).__recorderAddTrack;
  if (r) {
    await new Promise<void>((resolve) => {
      r.onstop = () => resolve();
      r.state !== "inactive" ? r.stop() : resolve();
    });
  }
  releaseClones();
  ctx?.close().catch(() => {});
  ctx = null;
  if (!r) return;

  const blob = new Blob(chunks, { type: "audio/webm" });
  chunks = [];
  if (blob.size < 5000) return; // sub-second blip — skip
  navigator.sendBeacon?.(`/api/calls/${callId}/audio`, blob) ||
    fetch(`/api/calls/${callId}/audio`, { method: "POST", body: blob }).catch(() => {});
}

export function recordingActive(): boolean {
  return !!recorder;
}
