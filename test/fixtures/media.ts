/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { userEvent } from "vitest/browser";
import { afterAll } from "vitest";

let sharedAudio: ReturnType<typeof createAudioSource> | undefined;

afterAll(async () => {
  if (sharedAudio) await sharedAudio.then(audio => audio.close(), () => {});
});

async function createAudioSource() {
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let oscillator: OscillatorNode | undefined;
  const start = document.createElement("button");
  start.textContent = "Start test audio";
  document.body.append(start);
  const resumed = new Promise<void>((resolve, reject) => {
    start.onclick = () => {
      try {
        context = new AudioContext();
        oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        stream = destination.stream;
        oscillator.frequency.value = 440;
        oscillator.connect(destination);
        const silentOutput = context.createGain();
        silentOutput.gain.value = 0;
        oscillator.connect(silentOutput);
        silentOutput.connect(context.destination);
        oscillator.start();
        void context.resume().then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    };
  });
  void resumed.catch(() => {});
  const close = async () => {
    stream?.getTracks().forEach(track => track.stop());
    oscillator?.disconnect();
    if (context && context.state !== "closed") {
      await context.close();
    }
  };
  try {
    await userEvent.click(start);
    await resumed;
    if (!stream) throw new Error("Audio startup completed without a source stream");
    return { stream, close };
  } catch (error) {
    await close().catch(console.error);
    throw error;
  } finally {
    start.onclick = null;
    start.remove();
  }
}

export async function mediaSource(kind: "audio" | "video") {
  if (kind === "audio") {
    const audio = await (sharedAudio ??= createAudioSource());
    const stream = audio.stream.clone();
    return { stream, close: async () => {
      stream.getTracks().forEach(track => track.stop());
    } };
  }
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const paint = () => {
    context.fillStyle = `hsl(${frame++ * 10 % 360}, 100%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  };
  paint();
  const stream = canvas.captureStream(15);
  const timer = setInterval(paint, 60);
  return { stream, close: async () => {
    clearInterval(timer);
    stream.getTracks().forEach(track => track.stop());
  } };
}
