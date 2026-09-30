/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type Interop, type PionPeer } from "../fixtures/interop";

type DataChannelStats = {
  type: string;
  id: string;
  dataChannelIdentifier: number;
  state: RTCDataChannelState;
  messagesSent: number;
  messagesReceived: number;
};

async function pionChannels(pion: PionPeer) {
  return (Object.values(await pion.stats()) as DataChannelStats[])
    .filter(stat => stat.type === "data-channel")
    .sort((a, b) => a.dataChannelIdentifier - b.dataChannelIdentifier);
}

async function exchangeMessages(channel: RTCDataChannel, generation: number) {
  channel.binaryType = "arraybuffer";
  const binary = Uint8Array.from({ length: 16_384 }, (_, i) => (i + generation) % 256);
  const messages = ["", `hello 🌍 ${generation}`, "fragmented".repeat(2000),
    new Uint8Array(), binary,
    ...Array.from({ length: 8 }, (_, i) => `generation ${generation}, channel ${channel.id}, message ${i}`)];
  const received: (string | Uint8Array)[] = [];
  const receive = (event: MessageEvent<string | ArrayBuffer>) => {
    received.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
  };
  channel.addEventListener("message", receive);
  try {
    for (const message of messages) {
      if (typeof message === "string") channel.send(message);
      else channel.send(message);
    }
    await expect.poll(() => received.length, { timeout: 10_000 }).toBe(messages.length);
    if (channel.ordered) expect(received).toEqual(messages);
    else expect(received).toEqual(expect.arrayContaining(messages));
    await expect.poll(() => channel.bufferedAmount).toBe(0);
    expect(channel.readyState).toBe("open");
    return messages.length;
  } finally {
    channel.removeEventListener("message", receive);
  }
}

async function closeChannel(interop: Interop, pion: PionPeer, channel: RTCDataChannel) {
  const id = channel.id;
  const closed = interop.event(channel, "close");
  channel.close();
  await closed;
  expect(channel.readyState).toBe("closed");
  await expect.poll(async () => (await pionChannels(pion))
    .every(stat => stat.dataChannelIdentifier !== id || stat.state === "closed")).toBe(true);
}

test("DTLS fingerprint restart preserves the original browser and Pion data channels", async ({ interop, skip }) => {
  if (/Firefox\//.test(navigator.userAgent)) skip("Firefox DTLS restart: https://bugzilla.mozilla.org/show_bug.cgi?id=1320903");
  await interop.features.require({ skip }, "pion.dtlsRestart", "browser.dtlsRestart");
  const pion = await interop.pionPeer({ behavior: "datachannel-echo" });
  const browser = interop.browserPeer();
  const options: RTCDataChannelInit[] = [
    { id: 0, ordered: true },
    { id: 2, ordered: false },
    { id: 4, ordered: false, maxRetransmits: 3 },
    { id: 6, ordered: true, maxPacketLifeTime: 10_000 },
  ];
  for (const option of options.slice(0, 2)) {
    await pion.createDataChannel(`preserved-${option.id}`, { ...option, negotiated: true });
  }
  let originalIDs: string[] | undefined;
  const channels = options.map((option, index) => browser.createDataChannel(`preserved-${option.id}`, {
    ...option, negotiated: index < 2,
  }));
  const events = channels.map(channel => {
    const count = { opens: 0, closes: 0 };
    channel.addEventListener("open", () => count.opens++);
    channel.addEventListener("close", () => count.closes++);
    return count;
  });
  await interop.negotiate(browser, pion);
  await Promise.all(channels.map(channel => interop.waitForOpen(channel)));
  const sctp = browser.sctp!;
  const dtls = sctp.transport;
  const attribute = (sdp: string, name: string) => {
    const value = sdp.match(new RegExp(`^a=${name}:(.+)`, "m"))?.[1].trim();
    expect(value, `SDP ${name}`).toBeTruthy();
    return value;
  };

  for (let generation = 0; generation < 3; generation++) {
    if (generation > 0) {
      const previous = (await pion.snapshot()).localDescription!.sdp!;
      const offer = await pion.createOffer({ dtlsRestart: true });
      for (const name of ["fingerprint", "ice-ufrag"]) {
        expect(attribute(offer.sdp!, name)).not.toBe(attribute(previous, name));
      }
      expect(attribute(offer.sdp!, "sctp-port")).toBe(attribute(previous, "sctp-port"));
      await pion.setLocalDescription(offer);
      await browser.setRemoteDescription(await interop.localDescription(pion));
      await browser.setLocalDescription(await browser.createAnswer());
      await pion.setRemoteDescription(await interop.localDescription(browser));
      await expect.poll(() => browser.connectionState, { timeout: 15_000 }).toBe("connected");
      await expect.poll(async () => (await pion.snapshot()).connectionState, { timeout: 15_000 }).toBe("connected");
    }
    expect(browser.sctp).toBe(sctp);
    expect(browser.sctp!.transport).toBe(dtls);
    const counts = await Promise.all(channels.map(async (channel, index) => {
      expect(channel.readyState).toBe("open");
      expect(events[index]).toEqual({ opens: 1, closes: 0 });
      options[index].id = channel.id!;
      return exchangeMessages(channel, generation);
    }));
    let closedID: number | null = null;
    for (let reuse = 0; reuse < 2; reuse++) {
      const channel = browser.createDataChannel(`new-${generation}-${reuse}`, { id: 10 });
      await interop.waitForOpen(channel);
      if (reuse > 0) expect(channel.id).toBe(closedID);
      closedID = channel.id;
      await exchangeMessages(channel, generation);
      await closeChannel(interop, pion, channel);
    }
    const incoming = interop.event<RTCDataChannelEvent>(browser, "datachannel");
    await pion.createDataChannel(`from-pion-${generation}`);
    const { channel } = await incoming;
    await interop.waitForOpen(channel);
    await exchangeMessages(channel, generation);
    await closeChannel(interop, pion, channel);
    for (const channel of channels) {
      expect(channel.readyState).toBe("open");
      const reply = interop.nextMessage(channel);
      channel.send(`still open ${generation}`);
      expect(await reply).toBe(`still open ${generation}`);
    }
    for (const count of events) expect(count).toEqual({ opens: 1, closes: 0 });
    const allStats = await pionChannels(pion);
    const stats = allStats.filter(stat => options.some(option => option.id === stat.dataChannelIdentifier));
    expect(allStats.filter(stat => !stats.includes(stat)).every(stat => stat.state === "closed")).toBe(true);
    originalIDs ??= stats.map(stat => stat.id);
    expect(stats.map(stat => stat.id)).toEqual(originalIDs);
    expect(stats).toHaveLength(options.length);
    for (const [index, stat] of stats.entries()) {
      expect(stat).toMatchObject({
        state: "open", messagesSent: (generation + 1) * (counts[index] + 1), messagesReceived: (generation + 1) * (counts[index] + 1),
      });
    }
    console.log(`DTLS fingerprint restart generation=${generation}: ${stats.length} original channels open; text/binary bursts, DCEP, close and SID reuse verified`);
  }
});

test("DTLS restart rotates supplied certificates and wraps while preserving a data channel", async ({ interop, skip }) => {
  if (/Firefox\//.test(navigator.userAgent)) skip("Firefox DTLS restart: https://bugzilla.mozilla.org/show_bug.cgi?id=1320903");
  await interop.features.require({ skip }, "pion.dtlsRestart", "browser.dtlsRestart");
  const pion = await interop.pionPeer({ behavior: "datachannel-echo", certificateCount: 3 });
  const expected = pion.certificateFingerprints.map(value => value.toUpperCase());
  expect(new Set(expected).size).toBe(3);
  const browser = interop.browserPeer();
  const channel = browser.createDataChannel("certificate-rotation");
  let opens = 0;
  let closes = 0;
  channel.addEventListener("open", () => opens++);
  channel.addEventListener("close", () => closes++);
  await interop.negotiate(browser, pion);
  await interop.waitForOpen(channel);
  const sctp = browser.sctp!;
  const dtls = sctp.transport;
  const fingerprint = (sdp: string) => {
    const value = sdp.match(/^a=fingerprint:sha-256 (.+)/m)?.[1].trim();
    expect(value).toBeTruthy();
    return value!.toUpperCase();
  };
  const remoteFingerprint = async () => {
    const certificates = dtls.getRemoteCertificates();
    expect(certificates.length).toBeGreaterThan(0);
    const digest = await crypto.subtle.digest("SHA-256", certificates[0]);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(":").toUpperCase();
  };

  for (let generation = 0; generation < 5; generation++) {
    const selected = expected[generation % expected.length];
    if (generation > 0) {
      const discarded = await pion.createOffer({ dtlsRestart: true });
      const offer = await pion.createOffer({ dtlsRestart: true });
      expect(fingerprint(discarded.sdp!)).toBe(selected);
      expect(fingerprint(offer.sdp!)).toBe(selected);
      await pion.setLocalDescription(offer);
      await browser.setRemoteDescription(await interop.localDescription(pion));
      await browser.setLocalDescription(await browser.createAnswer());
      await pion.setRemoteDescription(await interop.localDescription(browser));
      await expect.poll(() => browser.connectionState, { timeout: 15_000 }).toBe("connected");
      await expect.poll(async () => (await pion.snapshot()).connectionState, { timeout: 15_000 }).toBe("connected");
    }
    expect(fingerprint((await pion.snapshot()).localDescription!.sdp!)).toBe(selected);
    await expect.poll(remoteFingerprint, { timeout: 15_000 }).toBe(selected);
    expect(browser.sctp).toBe(sctp);
    expect(browser.sctp!.transport).toBe(dtls);
    expect(channel.readyState).toBe("open");
    const reply = interop.nextMessage(channel);
    channel.send(`certificate generation ${generation}`);
    expect(await reply).toBe(`certificate generation ${generation}`);
    expect({ opens, closes }).toEqual({ opens: 1, closes: 0 });
  }
});
