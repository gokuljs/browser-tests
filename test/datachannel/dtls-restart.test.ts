/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";

const attribute = (sdp: string, name: string) => {
  const value = sdp.match(new RegExp(`^a=${name}:(.+)`, "m"))?.[1].trim();
  expect(value, `SDP ${name}`).toBeTruthy();
  return value;
};

test("DTLS restart preserves the data channel across two new associations", async ({ interop, skip }) => {
  await interop.features.require({ skip }, "pion.dtlsRestart", "browser.dtlsRestart");
  const browser = interop.browserPeer();
  const pion = await interop.pionPeer({ behavior: "datachannel-echo" });
  const channel = browser.createDataChannel("dtls-restart", { negotiated: true, id: 0 });
  await pion.createDataChannel("dtls-restart", { negotiated: true, id: 0 });

  // Request tls-id on the initial offer too, so the association can be restarted.
  for (let generation = 0; generation < 3; generation++) {
    const previous = await pion.snapshot();
    const before = previous.localDescription?.sdp;
    const offer = await pion.createOffer({ dtlsRestart: true });
    attribute(offer.sdp!, "tls-id");
    if (before) {
      expect(attribute(offer.sdp!, "tls-id")).not.toBe(attribute(before, "tls-id"));
      expect(attribute(offer.sdp!, "ice-ufrag")).not.toBe(attribute(before, "ice-ufrag"));
      expect(attribute(offer.sdp!, "fingerprint")).toBe(attribute(before, "fingerprint"));
    }
    await pion.setLocalDescription(offer);
    await browser.setRemoteDescription(await interop.localDescription(pion));
    await browser.setLocalDescription(await browser.createAnswer());
    const browserTLSID = attribute(browser.localDescription!.sdp, "tls-id");
    if (previous.remoteDescription?.sdp) {
      expect(browserTLSID).not.toBe(attribute(previous.remoteDescription.sdp, "tls-id"));
    }
    await pion.setRemoteDescription(await interop.localDescription(browser));
    await interop.waitForOpen(channel);
    const message = `DTLS generation ${generation}`;
    const reply = interop.nextMessage(channel);
    channel.send(message);
    expect(await reply).toBe(message);
    expect((await pion.snapshot()).connectionState).toBe("connected");
  }
});
