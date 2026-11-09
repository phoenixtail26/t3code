// Fork feature: read aloud. Upstream's voice input has no seam a fork can listen on, but
// every way of speaking into T3 Code opens the microphone; hearing the voice while talking
// makes no sense, so reading stops when it does.
import { stopReadAloud } from "./player";

let installed = false;

export function stopReadAloudWhenTheMicrophoneOpens(): void {
  if (installed || typeof navigator === "undefined") return;
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;
  installed = true;
  // An own property over the prototype's method, looked up at call time.
  const prototype = Object.getPrototypeOf(devices) as MediaDevices;
  devices.getUserMedia = (constraints) => {
    if (constraints?.audio) stopReadAloud();
    return prototype.getUserMedia.call(devices, constraints);
  };
}
