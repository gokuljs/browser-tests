// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"errors"
	"io"
	"strings"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

const maxRTPObservations = 256

type observedRTP struct {
	SSRC           uint32 `json:"ssrc"`
	SequenceNumber uint16 `json:"sequenceNumber"`
	Timestamp      uint32 `json:"timestamp"`
	PayloadType    uint8  `json:"payloadType"`
	Payload        []byte `json:"payload"`
	Padding        bool   `json:"padding,omitempty"`
	PaddingSize    uint8  `json:"paddingSize,omitempty"`
}

type rtpSnapshot struct {
	Inbound     []observedRTP `json:"inbound"`
	Outbound    []observedRTP `json:"outbound"`
	Application []observedRTP `json:"application"`
	Errors      []string      `json:"errors"`
	Truncated   bool          `json:"truncated"`
}

// RED peers retain a bounded prefix; ordinary peers have no recorder.
type rtpRecorder struct {
	mu          sync.Mutex
	observation rtpSnapshot
}

func (r *rtpRecorder) record(target *[]observedRTP, header *rtp.Header, payload []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(*target) >= maxRTPObservations {
		r.observation.Truncated = true

		return
	}
	*target = append(*target, observedRTP{
		SSRC: header.SSRC, SequenceNumber: header.SequenceNumber, Timestamp: header.Timestamp,
		PayloadType: header.PayloadType, Payload: append([]byte{}, payload...),
		Padding: header.Padding, PaddingSize: header.PaddingSize,
	})
}

func (r *rtpRecorder) recordError(err error) {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.observation.Errors) < 8 {
		r.observation.Errors = append(r.observation.Errors, err.Error())
	}
}

func (r *rtpRecorder) snapshot() rtpSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()

	return rtpSnapshot{
		Inbound:     append([]observedRTP{}, r.observation.Inbound...),
		Outbound:    append([]observedRTP{}, r.observation.Outbound...),
		Application: append([]observedRTP{}, r.observation.Application...),
		Errors:      append([]string{}, r.observation.Errors...), Truncated: r.observation.Truncated,
	}
}

func (r *rtpRecorder) NewInterceptor(_ string) (interceptor.Interceptor, error) {
	return &rtpObserver{recorder: r}, nil
}

type rtpObserver struct {
	interceptor.NoOp
	recorder *rtpRecorder
}

func (o *rtpObserver) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	if !strings.EqualFold(info.MimeType, "audio/opus") {
		return writer
	}

	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		o.recorder.record(&o.recorder.observation.Outbound, header, payload)
		n, err := writer.Write(header, payload, attributes)
		o.recorder.recordError(err)

		return n, err
	})
}

func (o *rtpObserver) BindRemoteStream(info *interceptor.StreamInfo, reader interceptor.RTPReader) interceptor.RTPReader {
	if !strings.EqualFold(info.MimeType, "audio/opus") {
		return reader
	}

	return interceptor.RTPReaderFunc(func(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
		n, attributes, err := reader.Read(buffer, attributes)
		if err != nil {
			o.recorder.recordError(err)

			return n, attributes, err
		}
		var packet rtp.Packet
		if parseErr := packet.Unmarshal(buffer[:n]); parseErr != nil {
			o.recorder.recordError(parseErr)
		} else {
			o.recorder.record(&o.recorder.observation.Inbound, &packet.Header, packet.Payload)
		}

		return n, attributes, nil
	})
}
