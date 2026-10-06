/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type ObservedRTP } from "../fixtures/interop";
import { oscillatorSource } from "../fixtures/media";

type Codecs = { opus: number; red: number };
type Block = { payloadType: number; offset: number; payload: string };

function audioCodecs(description: RTCSessionDescriptionInit | null): Codecs {
  const audio = description?.sdp?.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "));
  expect(audio, "negotiated audio section").toBeDefined();
  const payloads = audio!.split(/\r?\n/)[0].split(" ").slice(3).map(Number);
  const type = (name: string) => {
    const match = audio!.match(new RegExp(`^a=rtpmap:(\\d+) ${name}/48000/2\\r?$`, "mi"));
    expect(match, `negotiated ${name}/48000/2`).not.toBeNull();
    const pt = Number(match![1]);
    expect(payloads).toContain(pt);
    return pt;
  };
  const opus = type("opus");
  const red = type("red");
  const association = audio!.match(new RegExp(`^a=fmtp:${red} ([^\\r\\n]+)`, "m"));
  expect(association, "RED fmtp association").not.toBeNull();
  const blocks = association![1].trim().split("/").map(Number);
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.every(pt => pt === opus), "RED protects negotiated Opus").toBe(true);
  return { opus, red };
}

// Independent RFC 2198 decoder: headers first, then redundant data, then primary.
function decodeRED(payload: string): { redundant: Block[]; primary: Block } {
  const bytes = Uint8Array.from(atob(payload), character => character.charCodeAt(0));
  const headers: { payloadType: number; offset: number; length: number }[] = [];
  let cursor = 0;
  while (cursor < bytes.length && bytes[cursor] & 0x80) {
    if (cursor + 4 > bytes.length) throw new Error("Truncated RED header");
    headers.push({ payloadType: bytes[cursor] & 0x7f,
      offset: (bytes[cursor + 1] << 6) | (bytes[cursor + 2] >> 2),
      length: ((bytes[cursor + 2] & 3) << 8) | bytes[cursor + 3] });
    cursor += 4;
  }
  if (cursor >= bytes.length) throw new Error("Missing RED primary header");
  const primaryType = bytes[cursor++];
  const encode = (start: number, end: number) => btoa(String.fromCharCode(...bytes.subarray(start, end)));
  const redundant = headers.map(header => {
    if (cursor + header.length > bytes.length) throw new Error("Truncated RED redundant data");
    const block = { payloadType: header.payloadType, offset: header.offset,
      payload: encode(cursor, cursor + header.length) };
    cursor += header.length;
    return block;
  });
  if (cursor === bytes.length) throw new Error("Empty RED primary data");
  return { redundant, primary: { payloadType: primaryType, offset: 0, payload: encode(cursor, bytes.length) } };
}

const identity = (packet: ObservedRTP) => `${packet.ssrc}/${packet.sequenceNumber}/${packet.timestamp}`;
const content = ({ ssrc, sequenceNumber, timestamp, payloadType, payload }: ObservedRTP): ObservedRTP =>
  ({ ssrc, sequenceNumber, timestamp, payloadType, payload });

function wireLedger(packets: ObservedRTP[], codecs: Codecs) {
  const primary = new Map<string, ObservedRTP>();
  const sources = new Map<string, ObservedRTP>();
  const carriers: { packet: ObservedRTP; blocks: Block[] }[] = [];
  const first = new Map<number, ObservedRTP>();
  const depths: number[] = [];
  let padding = 0;
  let knownCopies = 0;
  let inferredCopies = 0;
  const add = (packet: ObservedRTP) => {
    const previous = sources.get(identity(packet));
    if (previous) expect(packet.payload, "consistent RED source bytes").toBe(previous.payload);
    sources.set(identity(packet), packet);
  };
  for (const packet of packets) {
    expect([codecs.opus, codecs.red], "wire payload type is negotiated").toContain(packet.payloadType);
    if (packet.padding && packet.payload === "") {
      expect(packet.paddingSize, "padding-only RTP has a nonzero padding size").toBeGreaterThan(0);
      padding++;
      continue;
    }
    const decoded = packet.payloadType === codecs.red ? decodeRED(packet.payload) : {
      primary: { payloadType: packet.payloadType, payload: packet.payload, offset: 0 }, redundant: [],
    };
    expect(decoded.primary.payloadType).toBe(codecs.opus);
    const source = { ...content(packet), payloadType: codecs.opus, payload: decoded.primary.payload };
    primary.set(identity(source), source);
    add(source);
    if (!first.has(packet.ssrc)) first.set(packet.ssrc, source);
    if (packet.payloadType === codecs.red) depths.push(decoded.redundant.length);
    carriers.push({ packet, blocks: decoded.redundant });
  }
  // Resolve copies using independently observed primaries. RTP padding consumes
  // sequence numbers, so a copy need not be the immediately preceding RTP packet.
  for (const { packet, blocks } of carriers) {
    blocks.forEach((block, index) => {
      expect(block.payloadType, "redundant block protects Opus").toBe(codecs.opus);
      expect(block.offset, "redundant block carries earlier audio").toBeGreaterThan(0);
      expect(block.payload.length, "redundant Opus bytes").toBeGreaterThan(0);
      const timestamp = (packet.timestamp - block.offset) >>> 0;
      const candidates = Array.from(primary.values()).filter(source =>
        source.ssrc === packet.ssrc && source.timestamp === timestamp);
      if (candidates.length) {
        expect(candidates.some(source => source.payload === block.payload), "redundancy exactly copies observed primary bytes").toBe(true);
        knownCopies++;
        return;
      }
      // Only startup copies can precede this no-loss observation window. Their
      // sequence identity uses the receiver's documented contiguous-copy contract.
      const origin = first.get(packet.ssrc)!;
      expect((timestamp - origin.timestamp) | 0, "unseen copy precedes first observed primary").toBeLessThan(0);
      const sequenceNumber = (packet.sequenceNumber - blocks.length + index) & 0xffff;
      expect((sequenceNumber - origin.sequenceNumber + 0x8000 & 0xffff) - 0x8000,
        "inferred startup sequence precedes observed primaries").toBeLessThan(0);
      const copy = { ...content(packet), payloadType: codecs.opus, payload: block.payload, sequenceNumber, timestamp };
      add(copy);
      inferredCopies++;
    });
  }
  expect(depths.length, "actual wire RED carriers").toBeGreaterThan(5);
  expect(knownCopies, "useful verified redundancy").toBeGreaterThan(5);
  return { sources, primary, depths, copies: knownCopies, inferredCopies, padding };
}

for (const offerer of ["browser", "pion"] as const) {
  test(`Opus RED audio round trip (${offerer} offers)`, async ({ interop, skip }) => {
    const capabilities = ["pion.opusRED", "browser.opusREDSend", "browser.opusREDReceive"] as const;
    if (import.meta.env.VITE_REQUIRE_OPUS_RED === "1") {
      for (const name of capabilities) {
        const support = await interop.features.check(name);
        expect(support.supported, `${name}: ${support.reason ?? "required for RED validation"}`).toBe(true);
      }
    } else await interop.features.require({ skip }, ...capabilities);

    const media = await oscillatorSource();
    const playback = new AudioContext();
    const sink = document.createElement("video");
    sink.autoplay = true;
    sink.playsInline = true;
    sink.muted = true;
    document.body.append(sink);
    const analyser = playback.createAnalyser();
    const silentOutput = playback.createGain();
    silentOutput.gain.value = 0;
    analyser.connect(silentOutput).connect(playback.destination);
    let receivedTrack = false;
    try {
      await playback.resume();
      const browser = interop.browserPeer();
      browser.addEventListener("track", ({ track }) => {
        if (track.kind === "audio") {
          const remoteStream = new MediaStream([track]);
          sink.srcObject = remoteStream;
          playback.createMediaStreamSource(remoteStream).connect(analyser);
          receivedTrack = true;
        }
      });
      const pion = await interop.pionPeer({ behavior: "media-echo", opusRED: true });
      const track = media.stream.getAudioTracks()[0];
      browser.addTrack(track, media.stream);
      const transceiver = browser.getTransceivers().find(item => item.sender.track === track)!;
      // Preserve native capability records; RED preferences must keep Opus alongside it.
      const codecs = RTCRtpReceiver.getCapabilities("audio")!.codecs.filter(codec =>
        ["audio/red", "audio/opus"].includes(codec.mimeType.toLowerCase()));
      codecs.sort((left, right) => Number(right.mimeType.toLowerCase() === "audio/red") -
        Number(left.mimeType.toLowerCase() === "audio/red"));
      transceiver.setCodecPreferences(codecs);
      if (offerer === "browser") await interop.negotiate(browser, pion);
      else await interop.negotiate(pion, browser);
      const incoming = audioCodecs(browser.localDescription);
      const outgoing = audioCodecs(browser.remoteDescription);
      const inbound = async () => Array.from((await browser.getStats()).values()).find(stat =>
        stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats | undefined;
      const decodedSamples = async () => {
        const stats = await inbound();
        return (stats?.totalSamplesReceived ?? 0) - (stats?.concealedSamples ?? 0);
      };
      let errors: string[] = [];
      await expect.poll(async () => {
        errors = (await pion.rtp()).errors;
        return errors.length > 0 || ((await inbound())?.packetsReceived ?? 0) > 25;
      }, { timeout: 15_000 }).toBe(true);
      expect(errors, "Pion RED read/write failure interrupted the round trip").toEqual([]);
      const before = await decodedSamples();
      await expect.poll(decodedSamples, { timeout: 15_000 }).toBeGreaterThan(before + 4800);
      const waveform = new Float32Array(analyser.fftSize);
      await expect.poll(() => {
        analyser.getFloatTimeDomainData(waveform);
        return Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length);
      }, { timeout: 15_000 }).toBeGreaterThan(0.01);
      expect(receivedTrack).toBe(true);
      expect(browser.connectionState).toBe("connected");

      const observations = await pion.rtp();
      expect(observations.errors, "Pion RED read/write errors").toEqual([]);
      const received = wireLedger(observations.inbound, incoming);
      const sent = wireLedger(observations.outbound, outgoing);
      expect(observations.outbound[0].payloadType, "first Pion packet is ordinary Opus").toBe(outgoing.opus);
      expect(sent.depths, "one-copy Pion startup").toContain(1);
      expect(sent.depths, "two-copy Pion history").toContain(2);
      expect(Math.max(...sent.depths)).toBe(2);

      const delivered = new Set<string>();
      for (const packet of observations.application) {
        expect(packet.payloadType, "application receives Opus").toBe(incoming.opus);
        expect(delivered.has(identity(packet)), "no duplicate application delivery").toBe(false);
        expect(content(packet), "exact Opus payload and RTP identity from incoming carriers")
          .toEqual(received.sources.get(identity(packet)));
        delivered.add(identity(packet));
      }
      expect(delivered.size).toBeGreaterThan(25);
      // Snapshot may contain an inbound carrier still waiting for application delivery.
      // All earlier sources through the latest delivery must already be present.
      const origin = observations.inbound[0].sequenceNumber;
      const position = (sequence: number) => (sequence - origin + 0x8000 & 0xffff) - 0x8000;
      const last = Math.max(...observations.application.map(packet => position(packet.sequenceNumber)));
      for (const packet of received.sources.values()) {
        if (position(packet.sequenceNumber) <= last) expect(delivered.has(identity(packet)), "complete delivery before snapshot tail").toBe(true);
      }
      const echoed = new Map(observations.application.map(packet => [`${packet.sequenceNumber}/${packet.timestamp}`, packet.payload]));
      for (const packet of sent.primary.values()) {
        expect(packet.payload, "Pion echoes the application Opus bytes")
          .toBe(echoed.get(`${packet.sequenceNumber}/${packet.timestamp}`));
      }
      const browserStats = Array.from((await browser.getStats()).values());
      expect(browserStats.some(stat => stat.type === "outbound-rtp" && stat.kind === "audio" && stat.packetsSent > 25)).toBe(true);
      await expect.poll(async () => {
        const stats = Object.values(await pion.stats()) as RTCInboundRtpStreamStats[];
        return stats.find(stat => stat.type === "inbound-rtp" && stat.kind === "audio")?.packetsReceived ?? 0;
      }, { timeout: 5_000 }).toBeGreaterThan(25);
      // Pion currently exposes receiver RTP stats. Browser remote-inbound stats
      // prove normal Pion receiver reports arrive; sender report metrics vary.
      let senderReportPackets: number | undefined;
      await expect.poll(async () => {
        const stats = Array.from((await browser.getStats()).values());
        senderReportPackets = stats.find(stat => stat.type === "remote-outbound-rtp" && stat.kind === "audio")?.packetsSent;
        return stats.some(stat => stat.type === "remote-inbound-rtp" && stat.kind === "audio");
      }, { timeout: 5_000 }).toBe(true);
      expect((await pion.rtp()).errors, "no later Pion RED read/write failures").toEqual([]);
      console.log(`[Opus RED ${offerer} offers] inbound=${observations.inbound.length}, ` +
        `outbound=${observations.outbound.length}, Opus deliveries=${delivered.size}, ` +
        `verified copies=${received.copies}/${sent.copies}, inferred startup copies=${received.inferredCopies}/${sent.inferredCopies}, ` +
        `padding-only RTP=${received.padding}/${sent.padding}, decoded samples=${await decodedSamples()}, ` +
        `RTCP receiver report received, sender report packets=${senderReportPackets ?? "unavailable"}, ` +
        `bounded snapshot truncated=${observations.truncated}`);
    } finally {
      sink.pause();
      sink.srcObject = null;
      sink.remove();
      await playback.close();
      await media.close();
    }
  });
}
