import fs from "fs";
import { getDb } from "./db";
import { config } from "./config";
import { publish } from "./bus";
import { syncIntel } from "./ghl";

export type Analysis = {
  summary: string;
  action_items: string[];
  interest: number; // 1–5
  objections: string[];
  next_step: string;
};

/** Whisper → GPT analysis for one recorded call. Fire-and-forget; errors land in the call row. */
export async function processCall(callId: number): Promise<void> {
  const db = getDb();
  const call = db.prepare("SELECT id, recording_path FROM calls WHERE id=?").get(callId) as
    | { id: number; recording_path: string | null }
    | undefined;
  if (!call?.recording_path || !fs.existsSync(call.recording_path)) return;
  if (fs.statSync(call.recording_path).size < 20_000) return; // <~5s of opus — nothing to transcribe

  try {
    const transcript = await transcribe(call.recording_path);
    db.prepare("UPDATE calls SET transcript=? WHERE id=?").run(transcript, callId);
    if (transcript.trim().length < 20) return; // dead air / voicemail beep

    const analysis = await analyze(transcript);
    db.prepare("UPDATE calls SET analysis=? WHERE id=?").run(JSON.stringify(analysis), callId);
    publish({ type: "intel", payload: { call_id: callId, analysis } });
    void syncIntel(callId); // AI summary → GHL note, if the wrapup already went out without it
  } catch (err: any) {
    db.prepare("UPDATE calls SET analysis=? WHERE id=?").run(
      JSON.stringify({ error: String(err?.message || err) }),
      callId
    );
  }
}

/** OpenRouter chat call (browser UA required — Cloudflare 1010s default agents). */
async function openrouter(body: any): Promise<any> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) growzilla-dialer",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function transcribe(path: string): Promise<string> {
  // Preferred path: Gemini via OpenRouter — accepts the recorder's webm/opus as-is
  // (proven 2026-06-12 on call 258). Whisper stays as fallback for a valid OpenAI key.
  if (config.openrouterApiKey) {
    const data = await openrouter({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Transcribe this sales-call recording verbatim (Swedish and/or English, possibly both). " +
                "Output ONLY the spoken words as plain text — no commentary, no speaker labels, no timestamps. " +
                "If there is no speech, output an empty string.",
            },
            { type: "input_audio", input_audio: { data: fs.readFileSync(path).toString("base64"), format: "webm" } },
          ],
        },
      ],
    });
    return String(data.choices?.[0]?.message?.content ?? "");
  }
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(path)], { type: "audio/webm" }), "call.webm");
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { text: string }).text ?? "";
}

const ANALYZE_SYSTEM =
  'Analyze this cold-call transcript (caller sells Growzilla, a Shopify creator-attribution app). Reply ONLY with JSON: {"summary": "2 sentences max", "action_items": ["imperative, concrete"], "interest": 1-5, "objections": ["short"], "next_step": "one line"}. Empty arrays when nothing applies.';

async function analyze(transcript: string): Promise<Analysis> {
  if (config.openrouterApiKey) {
    const data = await openrouter({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: ANALYZE_SYSTEM },
        { role: "user", content: transcript.slice(0, 12_000) },
      ],
    });
    return JSON.parse(data.choices[0].message.content) as Analysis;
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: ANALYZE_SYSTEM },
        { role: "user", content: transcript.slice(0, 12_000) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`gpt ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content) as Analysis;
}
