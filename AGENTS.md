# AGENTS.md

## Project overview

webpagestreamer is a Docker container that captures a web page from headless Chromium and streams it as MPEG-TS. It uses Chrome's `tabCapture` API via a built-in extension — not Xvfb or PulseAudio.

## Architecture

Three processes run inside the container, managed by supervisord:

1. **Relay server** (`relay/server.js`) — Node.js WebSocket server that receives WebM chunks from the extension and pipes them to FFmpeg. FFmpeg transcodes to MPEG-2/MP2 MPEG-TS on stdout; the relay's output handler forwards it to the configured destination (UDP, TCP server, or file). Starts first (priority 10).

2. **Chrome** (`start.sh` generates `/tmp/launch-chrome.sh`) — Headless Chromium with the capture extension loaded. Navigates to the configured URL. Starts second (priority 20).

3. **Trigger** (`trigger-capture.sh`) — One-shot script that waits for Chrome's CDP port, then sends a `Runtime.evaluate` command via WebSocket to post a `CAPTURE_COMMAND` message to the page, which the content script listens for. Starts last (priority 30). Retries on unexpected failure.

## Data flow

```
Chrome tab → content.js (MediaRecorder, WebM) → WebSocket → relay/server.js → FFmpeg stdin → FFmpeg stdout (MPEG-TS) → relay output handler → UDP/TCP/file
```

## Key files

- `Dockerfile` — Single-stage Alpine 3.21 image. Installs Chromium, FFmpeg, Node.js, supervisor, Python3 + websockets.
- `start.sh` — Entrypoint. Sets defaults, generates the Chrome launch script, exports env vars, starts supervisord.
- `supervisord.conf` — Manages relay, chrome, and trigger processes. Relay and Chrome auto-restart; trigger retries on unexpected exit.
- `trigger-capture.sh` — Bash + inline Python. Polls CDP `/json` endpoint, finds the page tab's WebSocket debugger URL, sends `Runtime.evaluate` to start capture.
- `relay/server.js` — Spawns FFmpeg (outputs MPEG-TS to stdout), creates WebSocket server. Binary WebM messages from the extension are written to FFmpeg's stdin. FFmpeg stdout is forwarded to the configured output destination (UDP, TCP server, or file) via the relay's output handler. FFmpeg auto-restarts on exit.
- `extension/manifest.json` — Manifest V3. Permissions: tabs, tabCapture, activeTab, scripting. Has a hardcoded `key` field that determines the extension ID.
- `extension/background.js` — Service worker. Responds to `get-stream-id` messages by calling `chrome.tabCapture.getMediaStreamId()`.
- `extension/content.js` — Injected on all pages. Listens for `CAPTURE_COMMAND` window message, gets stream ID from background, calls `getUserMedia` with tab capture constraints, creates MediaRecorder (20ms timeslice), sends WebM chunks over WebSocket.

## Extension ID

The extension has a hardcoded public key in `manifest.json` which produces the fixed extension ID `akfimkeaknlnblgelnlelcgihcmconnb`. This ID is referenced in `start.sh` for the `--allowlisted-extension-id` Chrome flag. If you regenerate the key, update both files.

## Environment variables

All configurable via Docker env vars: `URL`, `OUTPUT`, `WIDTH`, `HEIGHT`, `FRAMERATE`, `WS_PORT`, `CDP_PORT`. Defaults are set in both the `Dockerfile` and `start.sh`.

## Testing

Build and run locally:
```bash
docker build -t webpagestreamer .
docker run --rm -p 9876:9876 -e URL="https://example.com" -e OUTPUT="tcp://0.0.0.0:9876" webpagestreamer
# Then: ffplay -f mpegts tcp://127.0.0.1:9876
```

Or use the test script:
```bash
./test.sh
```

For debugging, use file output:
```bash
docker run --rm -v /tmp:/output -e URL="https://example.com" -e OUTPUT="/output/test.ts" webpagestreamer
```

## Common pitfalls

- The `forceFrames()` function in `content.js` is critical — without it Chrome may not render frames on static pages, producing a frozen stream.
- The trigger script uses inline Python with the `websockets` library for CDP communication. The `python3-websockets` package must be installed in the container.
- The trigger script sets the viewport to exactly WIDTHxHEIGHT via `Emulation.setDeviceMetricsOverride` before triggering capture. Without this, `--window-size` only sets the outer window, not the content viewport.
- HTTP URLs require `--unsafely-treat-insecure-origin-as-secure` for `tabCapture` to work. `start.sh` detects `http://` URLs and adds this flag automatically.
- The content script hides scrollbars (`overflow: hidden`) and Chrome media overlay icons (PiP, cast) to keep the captured output clean.
- FFmpeg receives WebM on stdin and must handle the stream continuously — if the WebSocket disconnects and reconnects, FFmpeg gets a new WebM header which can cause errors. The relay server restarts FFmpeg when it exits.
- FFmpeg outputs MPEG-2 video with SAR 12:11 (PAL 4:3) and MP2 audio. The `repeat-headers` x264 option is no longer relevant since we switched to MPEG-2, but the short GOP (0.5s) ensures fast channel joining for consumers like hacktv.
- MediaRecorder timeslice is 20ms for low latency. Increasing this reduces CPU but adds latency.
