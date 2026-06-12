"use client";

/**
 * Per-call browser recorder: mixes the mic with every playing <audio> element
 * (the Vonage Client SDK plays the remote party through one) into a single
 * opus/webm stream. One file per lead call, uploaded on stop.
 */

let ctx: AudioContext | null = null;
let recorder: MediaRecorder | null = null;
let micStream: MediaStream | null = null;
let ownsMic = false;
let chunks: Blob[] = [];

export async function startCallRecording(): Promise<void> {
  if (recorder) return; // already rolling
  // Reuse the SDK's outgoing mic track if present — opening a SECOND getUserMedia can starve the
  // call's mic on some systems (outbound goes silent). Only open our own as a fallback.
  const sdkTrack = (window as any).__sdkMicTrack as MediaStreamTrack | undefined;
  if (sdkTrack && sdkTrack.readyState === "live") {
    micStream = new MediaStream([sdkTrack]);
    ownsMic = false;
  } else {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ownsMic = true;
  }
  ctx = new AudioContext();
  ctx.resume().catch(() => {});
  const mix = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(micStream).connect(mix);

  // Remote (prospect) audio. Primary source: the raw WebRTC tracks stashed by the
  // RTCPeerConnection patch in page.tsx — immune to <audio> srcObject swaps that made
  // recordings one-sided (every pre-2026-06-12 recording lacked the prospect's voice).
  // Tracks are deduped by id; late tracks (renegotiation mid-call) join via __recorderAddTrack.
  const seen = new Set<string>();
  const addTrack = (t: MediaStreamTrack) => {
    if (!ctx || t.kind !== "audio" || t.readyState !== "live" || seen.has(t.id)) return;
    seen.add(t.id);
    try {
      ctx.createMediaStreamSource(new MediaStream([t])).connect(mix);
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
}

/** Stop and upload to the call's audio endpoint. Resolves once the upload is sent. */
export async function stopCallRecording(callId: number): Promise<void> {
  const r = recorder;
  recorder = null;
  delete (window as any).__recorderAddTrack;
  if (!r) return;
  await new Promise<void>((resolve) => {
    r.onstop = () => resolve();
    r.state !== "inactive" ? r.stop() : resolve();
  });
  if (ownsMic) micStream?.getTracks().forEach((t) => t.stop()); // never stop the SDK's own track
  micStream = null;
  ctx?.close().catch(() => {});
  ctx = null;

  const blob = new Blob(chunks, { type: "audio/webm" });
  chunks = [];
  if (blob.size < 5000) return; // sub-second blip — skip
  navigator.sendBeacon?.(`/api/calls/${callId}/audio`, blob) ||
    fetch(`/api/calls/${callId}/audio`, { method: "POST", body: blob }).catch(() => {});
}

export function recordingActive(): boolean {
  return !!recorder;
}
