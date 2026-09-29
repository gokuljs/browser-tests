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
      const replacement = new RTCPeerConnection();
      try {
        offerer.createDataChannel("feature-probe");
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);

        replacement.createDataChannel("feature-probe");
        await replacement.setLocalDescription(await replacement.createOffer());
        await answerer.setRemoteDescription(replacement.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        return { supported: true };
      } catch (error) {
        if (!(error instanceof DOMException) ||
            !["NotSupportedError", "InvalidAccessError", "OperationError"].includes(error.name)) throw error;
        return { supported: false, reason: `Browser rejected fingerprint renegotiation: ${error.message}` };
      } finally {
        offerer.close();
        answerer.close();
        replacement.close();
      }
    },
  });
}
