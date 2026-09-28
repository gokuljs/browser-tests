/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
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

async function source(kind: "audio" | "video") {
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

for (const kind of ["audio", "video"] as const) {
  for (const offerer of ["browser", "pion"] as const) {
    test(`SRTP ${kind} round trip (${offerer} offers)`, async ({ interop }) => {
      const media = await source(kind);
      const playback = document.createElement("video");
      playback.autoplay = true;
      playback.playsInline = true;
      playback.muted = true;
      document.body.append(playback);
      try {
        const browser = interop.browserPeer();
        browser.addEventListener("track", ({ track }) => {
          if (track.kind === kind) playback.srcObject = new MediaStream([track]);
        });
        const pion = await interop.pionPeer({ behavior: "media-echo" });
        const track = media.stream.getTracks()[0];
        browser.addTrack(track, media.stream);
        const transceiver = browser.getTransceivers().find(item => item.sender.track === track)!;
        const mimeType = kind === "audio" ? "audio/opus" : "video/VP8";
        const codecs = RTCRtpReceiver.getCapabilities(kind)!.codecs.filter(codec => codec.mimeType.toLowerCase() === mimeType.toLowerCase());
        expect(codecs.length, `${mimeType} support`).toBeGreaterThan(0);
        transceiver.setCodecPreferences(codecs);
        if (offerer === "browser") await interop.negotiate(browser, pion);
        else await interop.negotiate(pion, browser);

        const received = async () => {
          const stats = await browser.getStats();
          return Array.from(stats.values()).find(stat => stat.type === "inbound-rtp" && stat.kind === kind) as RTCInboundRtpStreamStats | undefined;
        };
        await expect.poll(async () => (await received())?.packetsReceived ?? 0, { timeout: 15_000 }).toBeGreaterThan(10);
        if (kind === "video") {
          await expect.poll(async () => (await received())?.framesDecoded ?? 0, { timeout: 15_000 }).toBeGreaterThan(2);
        } else {
          await expect.poll(async () => {
            const inbound = await received();
            return (inbound?.totalSamplesReceived ?? 0) - (inbound?.concealedSamples ?? 0);
          }, { timeout: 15_000 }).toBeGreaterThan(0);
        }
        const stats = await browser.getStats();
        const inbound = await received();
        const codec = stats.get(inbound!.codecId!);
        expect(codec.mimeType.toLowerCase()).toBe(mimeType.toLowerCase());
        expect(browser.connectionState).toBe("connected");
      } finally {
        playback.pause();
        playback.srcObject = null;
        playback.remove();
        await media.close();
      }
    });
  }
}
