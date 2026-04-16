# webpagestreamer

A Docker container that captures any web page and streams it as MPEG-TS. Uses a Chrome extension to capture audio and video directly from Chromium's rendering pipeline — no Xvfb, x11grab, or PulseAudio required.

Inspired by [smallbraineng/webstreamer](https://github.com/smallbraineng/webstreamer), but outputs MPEG-TS to a configurable destination instead of streaming to Twitch over RTMP.

## How it works

```
Chromium (headless, with capture extension)
    │
    ├── Content script captures tab via chrome.tabCapture API
    │   └── MediaRecorder encodes to WebM (VP8 + Opus)
    │
    └── WebSocket ──► Relay server (Node.js)
                          │
                          └── FFmpeg (MPEG-2 + MP2 ──► MPEG-TS)
                                  │
                                  └── UDP / TCP / file output
```

1. **Chromium** launches headless with a built-in extension that captures the active tab's audio and video using `chrome.tabCapture`
2. The **content script** records the media stream as WebM and sends chunks over WebSocket to a local relay server
3. The **relay server** (Node.js) pipes the WebM data into **FFmpeg**, which transcodes to MPEG-2/MP2 MPEG-TS on stdout
4. The relay's **output handler** forwards the MPEG-TS to the configured destination (UDP, TCP server, or file)
5. **Supervisord** manages all processes (relay, Chrome, capture trigger) and restarts them on failure

## Quick start

```bash
docker build -t webpagestreamer .

# Stream a webpage over TCP (easiest way to verify it works)
docker run --rm -p 9876:9876 \
  -e URL="https://example.com" \
  -e OUTPUT="tcp://0.0.0.0:9876" \
  webpagestreamer

# Then in another terminal:
ffplay -f mpegts tcp://127.0.0.1:9876
```

### Test script

The easiest way to verify everything works:

```bash
./test.sh                           # Builds, runs with TCP output, shows connection info
URL="https://example.com" ./test.sh # Custom URL
DURATION=60 ./test.sh               # Run for 60s instead of default 30s
```

Then connect from another terminal with `ffplay -f mpegts tcp://127.0.0.1:9876` or VLC.

### Using docker-compose

```bash
# Edit docker-compose.yml to set your URL and output, then:
docker compose up --build
```

## Environment variables

| Variable    | Default                                    | Description                              |
|-------------|--------------------------------------------|------------------------------------------|
| `URL`       | `https://www.google.com`                   | Web page to capture                      |
| `OUTPUT`    | `udp://239.0.0.1:1234`                    | Output destination (UDP, RTP, TCP, or file) |
| `WIDTH`     | `720`                                      | Capture width in pixels                  |
| `HEIGHT`    | `576`                                      | Capture height in pixels (PAL: 576)      |
| `FRAMERATE` | `25`                                       | Frames per second (PAL: 25)              |
| `WS_PORT`   | `9000`                                     | Internal WebSocket relay port            |
| `CDP_PORT`  | `9222`                                     | Chrome DevTools Protocol port            |

## Output destinations

The `OUTPUT` variable supports four transport types:

### TCP (recommended for local testing)

The container runs a TCP server. Multiple clients can connect simultaneously. No timing or routing issues.

```bash
docker run --rm -p 9876:9876 \
  -e URL="https://example.com" \
  -e OUTPUT="tcp://0.0.0.0:9876" \
  webpagestreamer

# Connect with any MPEG-TS player:
ffplay -f mpegts tcp://127.0.0.1:9876
vlc tcp://127.0.0.1:9876
ffmpeg -f mpegts -i tcp://127.0.0.1:9876 -t 10 -c copy clip.ts
```

### UDP unicast / multicast

Best for production use where you need to feed an IPTV headend, hardware decoder, or network receiver.

```bash
# Unicast to a specific host
docker run --rm \
  -e URL="https://example.com" \
  -e OUTPUT="udp://192.168.1.100:1234" \
  webpagestreamer

# Multicast (requires --network host on Linux; does NOT work on macOS Docker)
docker run --rm --network host \
  -e URL="https://example.com" \
  -e OUTPUT="udp://239.0.0.1:1234" \
  webpagestreamer
```

> **Note:** UDP multicast does not work from Docker on macOS because Docker Desktop runs inside a Linux VM that doesn't route multicast to the host. Use TCP for local testing on Mac, or `--network host` on a Linux host.

### RTP (MPEG-TS over RTP)

MPEG-TS encapsulated in RTP per RFC 2250 (payload type 33). Use this for receivers that expect RTP framing, such as [mptsd](https://github.com/gfto/mptsd) and some professional IPTV gateways.

```bash
# Unicast RTP to an mptsd input
docker run --rm \
  -e URL="https://example.com" \
  -e OUTPUT="rtp://192.168.1.100:5004" \
  webpagestreamer

# Play with ffplay/VLC
ffplay -f rtp -i rtp://@:5004
vlc rtp://@:5004
```

Each RTP packet carries up to 7 TS packets (1316 bytes payload + 12-byte RTP header = 1328 bytes, safely under the 1500-byte MTU). Multicast addresses (224.0.0.0/4) are auto-detected and sent with TTL=4.

### File

Useful for debugging or recording.

```bash
docker run --rm -v /tmp:/output \
  -e URL="https://example.com" \
  -e OUTPUT="/output/stream.ts" \
  webpagestreamer

# Let it run, then play:
ffplay /tmp/stream.ts
```

## FFmpeg encoding settings

- **Video**: MPEG-2 (mpeg2video), 5 Mbps, interlaced flags, SAR 12:11 (PAL 4:3)
- **Audio**: MPEG-2 Layer 2 (MP2), 256 kbps, 48 kHz stereo
- **Container**: MPEG-TS (mpegts)
- **GOP**: 0.5 seconds (fast channel joining)
- **Pixel format**: yuv420p

## Project structure

```
├── Dockerfile              # Alpine-based container image
├── docker-compose.yml      # Compose file for easy local usage
├── test.sh                 # Quick test: builds and streams over TCP
├── start.sh                # Entrypoint: configures and launches supervisord
├── supervisord.conf        # Process manager for relay, Chrome, and trigger
├── trigger-capture.sh      # Uses CDP to tell the extension to start capturing
├── relay/
│   ├── server.js           # WebSocket → FFmpeg → output transport
│   └── package.json
└── extension/
    ├── manifest.json        # Chrome extension manifest (Manifest V3)
    ├── background.js        # Gets tabCapture stream ID
    └── content.js           # Captures media stream, sends via WebSocket
```

## Troubleshooting

**Container starts but no output stream**
- Check logs with `docker logs <container>` — look for `[trigger]`, `[capture]`, and `[relay]` messages
- The trigger script waits up to 60 seconds for Chrome CDP, then retries on failure
- For TCP, verify you can connect to the port: `nc -z 127.0.0.1 9876`

**High latency**
- The MediaRecorder uses a 20ms timeslice for low latency
- Network conditions between the container and receiver affect end-to-end latency

**HTTP URLs fail to capture (tabCapture error)**
- Chrome's `tabCapture` API requires HTTPS. The container automatically allows insecure origins for `http://` URLs via `--unsafely-treat-insecure-origin-as-secure`
- Content script also hides scrollbars and Chrome media overlay icons

**UDP multicast not working**
- Does not work on macOS Docker — use TCP for local testing
- On Linux, use `--network host` to allow multicast routing
- Check that your network infrastructure supports multicast (IGMP snooping, etc.)

**Accessing a local dev server from the container**
- Use `host.docker.internal` instead of `localhost`:
  ```bash
  -e URL="http://host.docker.internal:3000"
  ```

## License

MIT
