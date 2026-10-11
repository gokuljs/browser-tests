// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"testing"

	"github.com/pion/rtp"
	"github.com/stretchr/testify/require"
)

func TestRTPObservationConfiguration(t *testing.T) {
	for _, options := range []*redSourceOptions{nil, {}, {Tracks: 1}, {Tracks: 2}} {
		recorder, err := newRTPRecorder(false, 0, options)
		require.NoError(t, err)
		require.Equal(t, maxRTPObservations, recorder.observationLimit)
		tracks := 1
		if options != nil && options.Tracks == 2 {
			tracks = 2
		}
		require.Equal(t, tracks, recorder.sourceTracks)
		require.Equal(t, rtpTotals{}, recorder.snapshot().Totals)
	}
	for _, tracks := range []int{-1, 3} {
		_, err := newRTPRecorder(false, 0, &redSourceOptions{Tracks: tracks})
		require.ErrorContains(t, err, "tracks must be between 1 and 2")
	}
	for _, limit := range []int{1, maxRTPObservationLimit} {
		recorder, err := newRTPRecorder(false, limit, nil)
		require.NoError(t, err)
		require.Equal(t, limit, recorder.observationLimit)
	}
	for _, limit := range []int{-1, maxRTPObservationLimit + 1} {
		_, err := newRTPRecorder(false, limit, nil)
		require.ErrorContains(t, err, "observationLimit must be between 1 and 4096")
	}
}

func TestRTPObservationsKeepBoundedEvidenceAndLiveCounters(t *testing.T) {
	recorder, err := newRTPRecorder(false, 2, nil)
	require.NoError(t, err)
	payload := []byte{1, 2}
	for index := range 5 {
		header := rtp.Header{Version: 2, SSRC: 42, SequenceNumber: uint16(index), PayloadType: 63}
		if index == 0 {
			header.PayloadType = 111
		}
		recorder.record(&recorder.observation.Source, &header, payload)
		recorder.record(&recorder.observation.Application, &header, payload)
		recorder.recordWire(&recorder.observation.Inbound, &header, payload, 63)
		recorder.recordWire(&recorder.observation.Outbound, &header, payload, 63)
	}
	padding := rtp.Header{Version: 2, SSRC: 42, SequenceNumber: 5, PayloadType: 63, Padding: true, PaddingSize: 1}
	recorder.recordWire(&recorder.observation.Inbound, &padding, nil, 63)
	recorder.recordWire(&recorder.observation.Outbound, &padding, nil, 63)
	payload[0] = 8
	snapshot := recorder.snapshot()
	require.Len(t, snapshot.Source, 2)
	require.Len(t, snapshot.Application, 2)
	require.Len(t, snapshot.Inbound, 2)
	require.Len(t, snapshot.Outbound, 2)
	require.True(t, snapshot.Truncated)
	require.Equal(t, rtpTotals{Inbound: 6, Outbound: 6, Application: 5, InboundRED: 4, OutboundRED: 4}, snapshot.Totals)
	require.Equal(t, []byte{1, 2}, snapshot.Inbound[0].Payload, "evidence owns the recorded bytes")
	snapshot.Inbound[0].Payload[0] = 9
	require.Equal(t, []byte{1, 2}, recorder.snapshot().Inbound[0].Payload, "snapshot bytes cannot mutate evidence")
	header := rtp.Header{Version: 2, PayloadType: 63}
	recorder.recordWire(&recorder.observation.Inbound, &header, payload, 63)
	require.Equal(t, uint64(6), snapshot.Totals.Inbound, "old snapshots retain their counter values")
	require.Equal(t, uint64(7), recorder.snapshot().Totals.Inbound)
	require.Equal(t, uint64(5), recorder.snapshot().Totals.InboundRED)
	require.Empty(t, snapshot.Errors)
}

func TestREDSourceCompletionRequiresEveryTrack(t *testing.T) {
	for _, completeSecond := range []bool{false, true} {
		recorder, err := newRTPRecorder(false, 0, &redSourceOptions{Tracks: 2})
		require.NoError(t, err)
		recorder.sourceStarted()
		recorder.sourceStarted()
		recorder.sourceFinished(true)
		require.False(t, recorder.snapshot().SourceDone, "one finished track cannot complete two sources")
		require.False(t, recorder.mediaStopped())
		recorder.sourceFinished(completeSecond)
		require.Equal(t, completeSecond, recorder.snapshot().SourceDone, "cancellation must not claim source completion")
		require.True(t, recorder.mediaStopped())
	}
}
