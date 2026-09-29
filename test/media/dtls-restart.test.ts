/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { mediaSource } from "../fixtures/media";

test("DTLS restart keeps decrypting SRTP video on the same receiver", async ({ interop, skip }) => {
  await interop.features.require({ skip }, "pion.dtlsRestart", "browser.dtlsRestart");
  const media = await mediaSource("video");
  try {
    const browser = interop.browserPeer();
    const pion = await interop.pionPeer({ behavior: "media-echo" });
    browser.addTrack(media.stream.getVideoTracks()[0], media.stream);
    const transceiver = browser.getTransceivers()[0];
    transceiver.setCodecPreferences(RTCRtpReceiver.getCapabilities("video")!.codecs
      .filter(codec => codec.mimeType.toLowerCase() === "video/vp8"));
    const frames = async () => {
      const report = await browser.getStats();
      const inbound = Array.from(report.values()).find(stat => stat.type === "inbound-rtp" && stat.kind === "video");
      return inbound?.framesDecoded ?? 0;
    };
    let previousTLSID: string | undefined;
    for (let generation = 0; generation < 3; generation++) {
      const offer = await pion.createOffer({ dtlsRestart: true });
      const tlsID = offer.sdp!.match(/^a=tls-id:(.+)/m)?.[1];
      expect(tlsID).toBeTruthy();
      expect(tlsID).not.toBe(previousTLSID);
      previousTLSID = tlsID;
      await pion.setLocalDescription(offer);
      await browser.setRemoteDescription(await interop.localDescription(pion));
      await browser.setLocalDescription(await browser.createAnswer());
      expect(browser.localDescription!.sdp).toMatch(/^a=tls-id:\S+/m);
      await pion.setRemoteDescription(await interop.localDescription(browser));
      const before = await frames();
      await expect.poll(frames, { timeout: 15_000 }).toBeGreaterThan(before + 10);
      expect(browser.getTransceivers()[0].receiver).toBe(transceiver.receiver);
      expect((await pion.snapshot()).connectionState).toBe("connected");
    }
  } finally {
    await media.close();
  }
});
