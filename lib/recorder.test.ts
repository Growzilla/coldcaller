import assert from "node:assert/strict";
import { test } from "node:test";
import { startCallRecording, stopCallRecording } from "./recorder";

test("recording uses the call mic and does not open another capture", async () => {
  let gum = 0;
  const g = globalThis as any;
  g.window = {
    __sdkMicTrack: { kind: "audio", readyState: "live", id: "mic" },
    __rtcRemoteTracks: [],
  };
  g.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        gum += 1;
        throw new Error("recorder must not open a second mic");
      },
    },
    sendBeacon: () => true,
  };
  g.document = { querySelectorAll: () => [] };
  g.MediaStream = class {
    constructor(public tracks: unknown[]) {}
  };
  g.AudioContext = class {
    resume() {
      return Promise.resolve();
    }
    createMediaStreamDestination() {
      return { stream: {} };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    close() {
      return Promise.resolve();
    }
  };
  g.MediaRecorder = class {
    state = "recording";
    ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {}
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  };
  await startCallRecording();
  assert.equal(gum, 0);
  await stopCallRecording(1);
});
