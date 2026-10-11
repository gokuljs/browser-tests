# Pion Browser Tests

Browser interoperability tests for [pion/webrtc](https://github.com/pion/webrtc).
The suite connects real browser `RTCPeerConnection` instances to Pion peers and
checks signaling, data channels, media transport, and connection restarts.
Tests run in Chrome, Firefox, Edge, and Safari using Vitest and WebdriverIO.

## How it works

The [runner](scripts/run-browser-tests.ts) builds and starts a Go test server,
waits for it to become ready, and launches the selected browser. Tests control
Pion peers through the server's HTTP API: creating offers and answers,
exchanging ICE candidates, opening channels, and reading connection stats.

## Run locally

Install Node.js 24 or later, Go with the toolchain specified in [go.mod](go.mod),
and the browser you want to test. Browser automation also needs a matching
WebDriver. You can provide explicit paths when automatic discovery is unsuitable:

| Browser | Browser executable | WebDriver executable |
| --- | --- | --- |
| Chrome / Chromium | `CHROME_BIN` | `CHROMEDRIVER_PATH` |
| Firefox | `FIREFOX_BIN` | `GECKODRIVER_PATH` |
| Edge | `EDGE_BIN` | `EDGEDRIVER_PATH` |
| Safari | System Safari on macOS | System `safaridriver` |

Safari requires Remote Automation to be enabled. The CI action enables it with
`sudo safaridriver --enable`.

```sh
npm ci
npm run test:chrome
```

Use `test:firefox`, `test:edge`, or `test:safari` to select another browser.
`npm test` defaults to Chrome. Browsers run headlessly by default except Safari;
set `TEST_HEADLESS=false` to show another browser's window.

With Nix, `nix develop` provides Go and Node.js. On Linux it also provides
Chromium, Firefox, and their WebDrivers.

Arguments after `--` are forwarded to Vitest, apart from `--webrtc` and
`--interceptor`:

```sh
npm run test:chrome -- test/media/srtp.test.ts
npm run test:firefox -- test/datachannel/echo.test.ts -t 'echoes binary'
```

### Select the Pion version

By default, the server uses the dependency versions in this repository's
`go.mod`. Use `--webrtc` to test a local checkout, including uncommitted changes,
or a branch, tag, or commit from `pion/webrtc`:

```sh
npm run test:chrome -- --webrtc /path/to/webrtc
npm run test:firefox -- --webrtc main
```

Both WebRTC v4 and v5 checkouts are supported. The runner uses a temporary Go
workspace.

`PION_WEBRTC_SOURCE` is the environment-variable equivalent of `--webrtc`.
Set `PION_WEBRTC_REPOSITORY` to fetch remote revisions from a different Git
repository, such as a fork.

Use `--interceptor /path/to/interceptor` or `PION_INTERCEPTOR_SOURCE` to select an
interceptor checkout or ref. `PION_INTERCEPTOR_REPOSITORY` selects its repository.

## RED browser tests

The RED suite contains ten quick cases and one optional 30-minute soak. Other
browser interoperability tests remain part of the default suite.

| Test name | Purpose |
| --- | --- |
| RED audio works both ways when Pion offers | Check browser RED transmission, exact Pion delivery and echo, and audible browser playback. |
| Browser plays audio when Pion starts with RED | Check that playback starts when the first arriving audio packet is RED. |
| Browser plays RED using payload types 109 and 112 | Check negotiation, packet identifiers, and playback with non-default codec mappings. |
| Browser offers Opus only and plays Pion audio | Check that Pion answers with Opus and sends playable audio. |
| Browser offers Opus only and Pion receives audio | Check that Pion accepts and delivers the browser's plain Opus audio. |
| Pion offers RED and browser plays Opus-only audio | Check that Pion follows an answer selecting only Opus. |
| Pion offers RED and receives Opus-only browser audio | Check that browser transmission and Pion delivery use negotiated Opus. |
| Pion keeps two browser RED audio streams separate | Check separate stream identities and correct audio delivery for two browser tracks. |
| Browser plays two separate Pion RED audio streams | Check separate packet histories and audible playback on both browser tracks. |
| RED audio, video, and data survive renegotiation and ICE restart | Check that fresh media and data continue after both connection changes. |
| Optional: RED audio keeps flowing for 30 minutes | Check continued audio in both directions throughout a long connection. |

Run the ten quick cases against RED-enabled WebRTC and interceptor checkouts:

```sh
VITE_REQUIRE_OPUS_RED=pion npm run test:chrome -- \
  --webrtc /path/to/webrtc --interceptor /path/to/interceptor \
  test/media/opus-red --browser.fileParallelism=false --retry=0
```

Select another browser with its `test:*` command. The runner detects Pion's RED
API and enables the test-server adapter automatically. With the default
requirement mode, unsupported Pion or browser RED capabilities skip with an
explicit reason. `VITE_REQUIRE_OPUS_RED=pion` requires Pion RED while unsupported
browser send or receive directions still skip; `VITE_REQUIRE_OPUS_RED=1` requires
every RED direction used by each selected case.

The RED-first startup case checks playable audio after RED arrives first. It does
not verify exact recovery of the suppressed first audio frame.

The soak is excluded unless explicitly enabled and always measures the full
30 minutes:

```sh
VITE_OPUS_RED_SOAK=1 VITE_REQUIRE_OPUS_RED=1 npm run test:chrome -- \
  --webrtc /path/to/webrtc --interceptor /path/to/interceptor \
  soak/opus-red-soak.test.ts --browser.fileParallelism=false --retry=0
```

The CI action accepts `opus-red-suite: quick` or `opus-red-suite: soak`; leaving
it empty runs the default suite. The RED validation workflow runs quick cases
across its browser matrix and runs the Chrome soak only when `run-soak` is set.

## Development

Browser tests live in [test/](test/). Shared fixtures in
[test/fixtures/](test/fixtures/) manage browser and Pion peers, signaling,
media sources, and feature detection. The Go peer-control API and echo behaviors
live in [internal/testserver/](internal/testserver/).

```sh
npm run lint
npm run typecheck
npm run test:runner
go test ./...
```

`test:runner` checks process lifecycle and WebRTC source selection without
launching a browser. Run the relevant browser tests separately when changing
interop behavior. Test output includes available DTLS and SRTP transport details;
failed tests also log peer descriptions, state history, and stats.

## Community and license

Join the [Pion Discord](https://discord.gg/PngbdqpFbt) for discussion and see the
[contributing guide](https://github.com/pion/webrtc/wiki/Contributing) to get
involved.

MIT licensed. See [LICENSE](LICENSE).
