import assert from "node:assert/strict";
import { test } from "node:test";
import { startCallRecording, stopCallRecording } from "./recorder";

test("recording uses the call mic and does not open another capture", async () => {
  let gum = 0;
  let originalStops = 0;
  let cloneStops = 0;
  const streams: unknown[][] = [];
  const original = {
    kind: "audio",
    readyState: "live",
    id: "mic",
    stop() {
      originalStops += 1;
    },
    clone() {
      return {
        kind: "audio",
        readyState: "live",
        id: "mic-clone",
        stop() {
          cloneStops += 1;
        },
      };
    },
  };
  const g = globalThis as any;
  g.window = {
    __sdkMicTrack: original,
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
    constructor(public tracks: unknown[]) {
      streams.push(tracks);
    }
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
  assert.equal(streams.length, 1);
  assert.notEqual(streams[0][0], original);
  await stopCallRecording(1);
  assert.equal(originalStops, 0);
  assert.equal(cloneStops, 1);
});
