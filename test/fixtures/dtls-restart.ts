/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { expect, type Interop, type PionPeer } from "./interop";

export async function negotiateFingerprintRestart(interop: Interop, browser: RTCPeerConnection, pion: PionPeer) {
  const previous = await pion.snapshot();
  await browser.setLocalDescription(await browser.createOffer());
  const offer = await interop.localDescription(browser);
  const attribute = (sdp: string, name: string) => {
    const value = sdp.match(new RegExp(`^a=${name}:(.+)`, "m"))?.[1].trim();
    expect(value, `SDP ${name}`).toBeTruthy();
    return value;
  };
  if (previous.remoteDescription?.sdp) {
    for (const name of ["fingerprint", "ice-ufrag"]) {
      expect(attribute(offer.sdp!, name)).not.toBe(attribute(previous.remoteDescription.sdp, name));
    }
  }
  await pion.setRemoteDescription(offer);
  await pion.setLocalDescription(await pion.createAnswer());
  await browser.setRemoteDescription(await interop.localDescription(pion));
  await expect.poll(() => browser.connectionState, { timeout: 15_000 }).toBe("connected");
  await expect.poll(async () => (await pion.snapshot()).connectionState, { timeout: 15_000 }).toBe("connected");
}
