/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { mediaSource } from "../fixtures/media";

for (const kind of ["audio", "video"] as const) {
  for (const offerer of ["browser", "pion"] as const) {
    test(`SRTP ${kind} round trip (${offerer} offers)`, async ({ interop }) => {
      const media = await mediaSource(kind);
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
