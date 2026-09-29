// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOptionalBoolOption(t *testing.T) {
	old := struct{ ICERestart bool }{}
	current := struct{ DTLSRestart bool }{}
	wrongType := struct{ DTLSRestart string }{}
	require.False(t, boolOption(&old, "DTLSRestart").IsValid())
	require.False(t, boolOption(&wrongType, "DTLSRestart").IsValid())
	require.False(t, boolOption(nil, "DTLSRestart").IsValid())
	require.False(t, boolOption(current, "DTLSRestart").IsValid())
	field := boolOption(&current, "DTLSRestart")
	require.True(t, field.IsValid())
	field.SetBool(true)
	require.True(t, current.DTLSRestart)
}

func TestFeatureDiscoveryAndOptionalOffer(t *testing.T) {
	server := New()
	defer server.Close()
	mux := http.NewServeMux()
	server.Register(mux)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(method, path, strings.NewReader(body)))

		return response
	}
	response := call("GET", "/features", "")
	require.Equal(t, http.StatusOK, response.Code)
	var capabilities map[string]featureSupport
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &capabilities))
	require.Contains(t, capabilities, "dtlsRestart")
	response = call("POST", "/peers", `{}`)
	require.Equal(t, http.StatusOK, response.Code)
	var created map[string]string
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &created))
	peerPath := "/peers/" + created["id"]
	require.Equal(t, http.StatusOK, call("POST", peerPath+"/create-data-channel", `{"label":"test"}`).Code)
	response = call("POST", peerPath+"/create-offer", `{"iceRestart":false}`)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = call("POST", peerPath+"/create-offer", `{"dtlsRestart":true}`)
	if capabilities["dtlsRestart"].Supported {
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), "a=tls-id:")
	} else {
		require.Equal(t, http.StatusNotImplemented, response.Code)
		require.NotEmpty(t, capabilities["dtlsRestart"].Reason)
		require.Contains(t, response.Body.String(), capabilities["dtlsRestart"].Reason)
	}
}
