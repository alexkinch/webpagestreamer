# webpagestreamer

A Docker container that captures any web page and streams it as MPEG-TS. Uses a Chrome extension to capture audio and video directly from Chromium's rendering pipeline — no Xvfb, x11grab, or PulseAudio required.

Inspired by [smallbraineng/webstreamer](https://github.com/smallbraineng/webstreamer), but outputs MPEG-TS to a configurable destination instead of streaming to Twitch over RTMP.

## Scope

This tool produces an **MPEG-TS stream** from a captured web page and pushes it to one transport (UDP / RTP / TCP / file). For multi-client HTTP/HLS/RTSP/WebRTC fanout, point the OUTPUT at a downstream server such as [mediamtx](https://github.com/bluenviron/mediamtx), [mptsd](https://github.com/gfto/mptsd), or nginx-rtmp.

## How it works

```
Chromium (headless, with capture extension)
    │
    ├── chrome.tabCapture → MediaStream (audio + video tracks)
    ├── MediaStreamTrackProcessor(video) → I420 frames
    └── MediaStreamTrackProcessor(audio) → f32le PCM
              │
              └── two WebSockets (binary, ~25 fps + ~44.1 kHz)
                        │
                        ▼
                  Relay (Node.js)
                        │
                        └── named pipes → FFmpeg → MPEG-TS
                                            │
                                            └── OUTPUT (UDP / RTP / TCP / file)
```

1. **Chromium** launches headless with a built-in extension that captures the active tab's audio and video using `chrome.tabCapture`.
2. The **content script** uses `MediaStreamTrackProcessor` to get raw `VideoFrame` and `AudioData` objects, packs them as I420 + interleaved f32le, and ships them over two WebSocket connections.
3. The **relay** writes each WS message into a named pipe; **FFmpeg** reads the two pipes as `-f rawvideo` + `-f f32le` and encodes to MPEG-TS.
4. FFmpeg pushes MPEG-TS to the configured `OUTPUT` (UDP, RTP, TCP listener, or file).
5. **Supervisord** manages all processes and restarts them on failure.

The relay also serves IPTV integration endpoints (XMLTV guide, M3U playlist, health) on `WS_PORT` for use by IPTV gateways.

## Quick start

```bash
docker build -t webpagestreamer .

# Stream over TCP (one-client testing)
docker run --rm -p 9876:9876 \
  -e URL="https://example.com" \
  -e OUTPUT="tcp://0.0.0.0:9876?listen=1" \
  webpagestreamer

# Then in another terminal:
ffplay -f mpegts tcp://127.0.0.1:9876
```

### Test script

```bash
./test.sh                           # Builds, runs with TCP output
URL="https://example.com" ./test.sh
DURATION=60 ./test.sh
```

## Environment variables

| Variable    | Default                  | Description                              |
|-------------|--------------------------|------------------------------------------|
| `URL`       | `https://www.google.com` | Web page to capture                      |
| `OUTPUT`    | `udp://239.0.0.1:1234`   | UDP / RTP / TCP / file destination       |
| `PROFILE`   | `pal`                    | Encoding profile (`pal`, `ntsc`, `720p`, `1080p`) |
| `WIDTH`     | from profile             | Capture width in pixels                  |
| `HEIGHT`    | from profile             | Capture height in pixels                 |
| `FRAMERATE` | from profile             | Frames per second                        |
| `WS_PORT`   | `9000`                   | Port for IPTV metadata endpoints + WS ingest |
| `CDP_PORT`  | `9222`                   | Chrome DevTools Protocol port (internal) |

Encoding overrides: `VIDEO_CODEC`, `AUDIO_CODEC`, `VIDEO_BITRATE`, `AUDIO_BITRATE`, `SAR`, `INTERLACED`, `B_FRAMES` all override the profile defaults.

IPTV metadata: `CHANNEL_NAME`, `CHANNEL_ID`, `PROGRAMME_TITLE`, `PROGRAMME_DESC`, `STREAM_URL`.

## OUTPUT modes

### TCP

ffmpeg owns the socket directly — no Node middleman. Two modes:

- `tcp://0.0.0.0:9876?listen=1` — ffmpeg binds and waits for one client to connect, then streams. Single concurrent client; once it disconnects, ffmpeg exits and supervisord restarts (which reopens the listen socket).
- `tcp://<host>:<port>` (no `?listen=1`) — ffmpeg dials out to that address. Use this for a downstream server that accepts incoming TCP MPEG-TS.

```bash
docker run --rm -p 9876:9876 \
  -e OUTPUT="tcp://0.0.0.0:9876?listen=1" webpagestreamer
ffplay -f mpegts tcp://127.0.0.1:9876
```

### UDP unicast / multicast

Best for IPTV / broadcast workflows. UDP is push-only — point the encoder at the destination IP and port.

```bash
# Unicast to a specific host (e.g. an mptsd input)
docker run --rm \
  -e OUTPUT="udp://192.168.1.100:1234" webpagestreamer

# Multicast (Linux only — requires --network host; does NOT work on macOS Docker)
docker run --rm --network host \
  -e OUTPUT="udp://239.0.0.1:1234" webpagestreamer
```

> **Note:** UDP multicast does not work from Docker on macOS — Docker Desktop's Linux VM doesn't bridge multicast to the host. Use TCP for local testing on Mac, `--network host` on Linux.

### RTP (MPEG-TS over RTP, RFC 2250)

For receivers that want RTP framing — e.g. [mptsd](https://github.com/gfto/mptsd), some professional IPTV gateways.

```bash
docker run --rm \
  -e OUTPUT="rtp://192.168.1.100:5004" webpagestreamer

# To receive:
ffplay -f rtp -i rtp://@:5004
```

Each RTP packet carries up to 7 TS packets (1316 B payload + 12 B header = 1328 B, safely under 1500 MTU). Multicast addresses (224.0.0.0/4) auto-detect and send with TTL=4.

### File

Useful for recording / debugging.

```bash
docker run --rm -v /tmp:/output \
  -e OUTPUT="/output/stream.ts" webpagestreamer
ffplay /tmp/stream.ts
```

## Wanting HLS / multi-client HTTP / RTSP / WebRTC?

Run a downstream streaming server. Recipe with mediamtx:

```bash
# 1. Run mediamtx somewhere on the LAN, configured to ingest MPEG-TS over UDP
#    (see https://github.com/bluenviron/mediamtx — "MPEG-TS over UDP" publish).

# 2. Point this container at it:
docker run --rm \
  -e URL="https://example.com" \
  -e OUTPUT="udp://<mediamtx-host>:9999" \
  webpagestreamer

# 3. Consume from mediamtx — RTSP, HLS, WebRTC, etc.
```

For H.264-codec consumers, also set `-e PROFILE=720p` (or override with `VIDEO_CODEC=libx264 AUDIO_CODEC=aac`) so mediamtx's HLS muxer accepts the stream.

## Encoding defaults

PAL profile (`PROFILE=pal`):

- **Video**: MPEG-2 (mpeg2video), 5 Mbps, progressive, SAR 12:11 (PAL 4:3)
- **Audio**: MPEG-2 Layer 2 (MP2), 256 kbps, 48 kHz stereo (resampled from browser's 44.1 kHz)
- **GOP**: ~0.5 s (fast channel joining)
- **B-frames**: 0 (set `B_FRAMES=2` for better compression at cost of latency)

For broadcast PAL specifically (interlaced 25i), set `INTERLACED=true`. Default is progressive because that's what nearly every modern player wants.

## Project structure

```
├── Dockerfile              # Alpine + Chromium + ffmpeg + Node + supervisord
├── docker-compose.yml
├── test.sh
├── start.sh                # Entrypoint
├── supervisord.conf
├── trigger-capture.sh      # CDP-driven capture trigger
├── relay/
│   ├── server.js           # WS ingest → fifos → ffmpeg → OUTPUT
│   ├── ingest.js           # WS endpoints for raw video + audio
│   └── package.json
└── extension/
    ├── manifest.json
    ├── background.js       # tabCapture stream-ID broker
    └── content.js          # MediaStreamTrackProcessor → WebSocket
```

## Troubleshooting

**No output stream**
- `docker logs <container>` — look for `[trigger]`, `[capture]`, `[ingest]`, `[ffmpeg]`.
- For TCP/UDP destinations: confirm port reachability from the receiver.

**HTTP URLs fail to capture (tabCapture error)**
- Chrome's `tabCapture` requires HTTPS. The container auto-allows `http://` URLs via `--unsafely-treat-insecure-origin-as-secure`.

**UDP multicast not working on macOS**
- Known Docker Desktop limitation. Use TCP for local testing, or run on Linux with `--network host`.

**Accessing a local dev server from the container**
- Use `host.docker.internal` instead of `localhost`:
  ```bash
  -e URL="http://host.docker.internal:3000"
  ```

## License

MIT
