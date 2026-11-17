/**
 * One mic capture for the call. A second getUserMedia on the same device makes
 * Chrome send the lead silence while the local recording still has speech.
 * Noise suppression stays off: on the headset it gates consonants, so the lead
 * hears a quiet voice that cuts out. Echo cancellation and auto gain stay on.
 */

export function voiceMicConstraints(deviceId: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: 1,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/** The meter may open a capture only while the call does not already hold the mic. */
export function meterMayCapture(callOwnsMic: boolean): boolean {
  return !callOwnsMic;
}
