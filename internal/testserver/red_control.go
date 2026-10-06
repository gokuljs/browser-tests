// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"errors"
	"fmt"

	"github.com/pion/rtp"
)

const maxRTPObservationLimit = 4096

type redSourceOptions struct {
	Packets        int     `json:"packets"`
	Trailers       int     `json:"trailers"`
	SequenceStart  *uint16 `json:"sequenceStart"`
	TimestampStart *uint32 `json:"timestampStart"`
	IntervalMS     *int    `json:"intervalMs"`
}

type redImpairmentOptions struct {
	OutboundDrop []int `json:"outboundDrop"`
}

type redSourceConfig struct {
	packets        int
	trailers       int
	sequenceStart  uint16
	timestampStart uint32
	intervalMS     int
	controlled     bool
}

var errInvalidREDControl = errors.New("invalid RED test controls") //nolint:gochecknoglobals

func sourceConfig(options *redSourceOptions) (redSourceConfig, error) {
	configuration := redSourceConfig{
		packets: redAudioPacketCount, sequenceStart: 1000, timestampStart: 48000, intervalMS: 20,
		controlled: options != nil,
	}
	if options == nil {
		return configuration, nil
	}
	if options.Packets != 0 {
		configuration.packets = options.Packets
	}
	configuration.trailers = options.Trailers
	if options.SequenceStart != nil {
		configuration.sequenceStart = *options.SequenceStart
	}
	if options.TimestampStart != nil {
		configuration.timestampStart = *options.TimestampStart
	}
	if options.IntervalMS != nil {
		configuration.intervalMS = *options.IntervalMS
	}
	if configuration.packets < 1 || configuration.trailers < 0 || configuration.trailers > 2 ||
		configuration.packets > maxRTPObservationLimit-1-configuration.trailers ||
		configuration.intervalMS < 0 || configuration.intervalMS > 1000 {
		return redSourceConfig{}, fmt.Errorf("%w: require 1..4095 total packets, 0..2 trailers, intervalMs 0..1000",
			errInvalidREDControl)
	}

	return configuration, nil
}

func newRTPRecorder(
	startWithRED bool, observationLimit int, source *redSourceOptions, impairment *redImpairmentOptions,
) (*rtpRecorder, error) {
	configuration, err := sourceConfig(source)
	if err != nil {
		return nil, err
	}
	if observationLimit == 0 {
		observationLimit = maxRTPObservations
	}
	if observationLimit < 1 || observationLimit > maxRTPObservationLimit {
		return nil, fmt.Errorf("%w: observationLimit must be between 1 and %d", errInvalidREDControl, maxRTPObservationLimit)
	}
	recorder := &rtpRecorder{
		startWithRED: startWithRED, observationLimit: observationLimit, source: configuration,
		outboundDrop: make(map[int]bool),
	}
	if impairment != nil {
		recorder.source.controlled = true
		for _, ordinal := range impairment.OutboundDrop {
			if ordinal < 0 || ordinal >= configuration.packets+configuration.trailers || recorder.outboundDrop[ordinal] {
				return nil, fmt.Errorf("%w: outboundDrop contains invalid or repeated media ordinal %d", errInvalidREDControl, ordinal)
			}
			recorder.outboundDrop[ordinal] = true
		}
	}

	return recorder, nil
}

func (source redSourceConfig) header(index int, payloadType uint8, ssrc uint32) rtp.Header {
	return rtp.Header{
		Version: 2, PayloadType: payloadType, SSRC: ssrc,
		SequenceNumber: uint16((int(source.sequenceStart) + index) & 0xffff), //nolint:gosec // Deliberate RTP wrap.
		Timestamp:      source.timestampStart + uint32(index)*960,            //nolint:gosec // Packet count is bounded.
	}
}

func (source redSourceConfig) sentinel(payloadType uint8, ssrc uint32) rtp.Packet {
	header := source.header(source.packets+source.trailers, payloadType, ssrc)
	header.Padding, header.Marker, header.PaddingSize = true, true, 1

	return rtp.Packet{Header: header}
}

func (r *rtpRecorder) isDrainSentinel(packet *rtp.Packet, opusPayloadType uint8, ssrc uint32) bool {
	if !r.source.controlled {
		return false
	}
	expected := r.source.sentinel(opusPayloadType, ssrc)

	return packet.SSRC == expected.SSRC && packet.PayloadType == expected.PayloadType &&
		packet.SequenceNumber == expected.SequenceNumber && packet.Timestamp == expected.Timestamp &&
		packet.Padding && packet.PaddingSize == 1 && packet.Marker && len(packet.Payload) == 0
}
