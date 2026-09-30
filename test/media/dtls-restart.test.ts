/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { mediaSource } from "../fixtures/media";
import { negotiateFingerprintRestart } from "../fixtures/dtls-restart";

test("DTLS fingerprint restart restores SRTP video echo on the same Pion peer", async ({ interop, skip }) => {
  if (/Firefox\//.test(navigator.userAgent)) skip("Firefox DTLS restart: https://bugzilla.mozilla.org/show_bug.cgi?id=1320903");
  await interop.features.require({ skip }, "pion.dtlsRestart", "browser.dtlsRestart");
  const media = await mediaSource("video");
  try {
    const pion = await interop.pionPeer({ behavior: "media-echo" });
    for (let generation = 0; generation < 3; generation++) {
      const browser = interop.browserPeer();
      const sender = browser.addTrack(media.stream.getVideoTracks()[0], media.stream);
      const transceiver = browser.getTransceivers()[0];
      transceiver.setCodecPreferences(RTCRtpReceiver.getCapabilities("video")!.codecs
        .filter(codec => codec.mimeType.toLowerCase() === "video/vp8"));
      await negotiateFingerprintRestart(interop, browser, pion);
      const frames = async () => {
        const report = await browser.getStats();
        const inbound = Array.from(report.values()).find(stat => stat.type === "inbound-rtp" && stat.kind === "video");
        return inbound?.framesDecoded ?? 0;
      };
      await expect.poll(frames, { timeout: 15_000 }).toBeGreaterThan(10);
      // Stop the old sender without sending a DTLS close alert to Pion.
      await sender.replaceTrack(null);
    }
  } finally {
    await media.close();
  }
});
