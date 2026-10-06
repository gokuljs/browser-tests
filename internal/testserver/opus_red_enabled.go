// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

//go:build pion_opus_red

package testserver

import (
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

func opusREDSupport() featureSupport { return featureSupport{Supported: true} }

func newOpusREDPeer(
	settings webrtc.SettingEngine, configuration webrtc.Configuration, observation *rtpRecorder,
) (*webrtc.PeerConnection, error) {
	media := &webrtc.MediaEngine{}
	if err := media.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(media, registry); err != nil {
		return nil, err
	}
	// Observe RED on the wire side of the encoder/decoder, alongside reports and stats.
	registry.Add(observation)
	if err := webrtc.ConfigureOpusRED(111, 63, media, registry); err != nil {
		return nil, err
	}

	return webrtc.NewAPI(
		webrtc.WithSettingEngine(settings),
		webrtc.WithMediaEngine(media),
		webrtc.WithInterceptorRegistry(registry),
	).NewPeerConnection(configuration)
}
