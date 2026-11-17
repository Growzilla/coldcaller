import assert from "node:assert/strict";
import { test } from "node:test";
import { meterMayCapture, voiceMicConstraints } from "./mic-capture";

test("call capture keeps echo cancellation and gain, and pins the chosen mic", () => {
  const pinned = voiceMicConstraints("headset-1");
  assert.equal(pinned.echoCancellation, true);
  assert.equal(pinned.autoGainControl, true);
  assert.equal(pinned.noiseSuppression, false);
  assert.equal(pinned.channelCount, 1);
  assert.deepEqual(pinned.deviceId, { exact: "headset-1" });
  assert.equal("deviceId" in voiceMicConstraints(""), false);
});

test("level meter must not open a second capture while a call holds the mic", () => {
  assert.equal(meterMayCapture(false), true);
  assert.equal(meterMayCapture(true), false);
});
