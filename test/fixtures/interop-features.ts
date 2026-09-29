/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */

import { FeatureDetector, type FeatureSupport } from "./features";

export function interopFeatures(loadPionFeatures: () => Promise<Record<string, FeatureSupport>>) {
  return new FeatureDetector({
    "pion.dtlsRestart": async () => {
      const features = await loadPionFeatures();
      return features.dtlsRestart ?? { supported: false, reason: "Server does not advertise dtlsRestart" };
    },
    "browser.dtlsRestart": async () => {
      const offerer = new RTCPeerConnection();
      const answerer = new RTCPeerConnection();
      try {
        offerer.createDataChannel("feature-probe");
        const offer = await offerer.createOffer();
        // Probe the answerer's RFC 8842 tls-id negotiation without a network handshake.
        offer.sdp = offer.sdp!.replace(/^a=tls-id:.*\r?\n/gm, "")
          .replace(/(^m=.*\r?\n)/gm, "$1a=tls-id:interop-feature-probe\r\n");
        await answerer.setRemoteDescription(offer);
        const answer = await answerer.createAnswer();
        const supported = /^a=tls-id:\S+/m.test(answer.sdp ?? "");
        return { supported, reason: supported ? undefined : "Browser does not negotiate SDP tls-id" };
      } finally {
        offerer.close();
        answerer.close();
      }
    },
  });
}
