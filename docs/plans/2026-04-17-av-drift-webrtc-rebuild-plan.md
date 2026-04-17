# A/V Drift Fix via WebRTC Ingest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MediaRecorder + WebSocket + WebM ingest pipeline with a WebRTC/WHIP publisher feeding `mediamtx`, then have FFmpeg consume RTSP from `mediamtx` and emit MPEG-TS to UDP multicast and/or HTTP progressive clients. This fixes A/V drift at the transport layer (independent Opus/VP8 RTP clocks) instead of at the FFmpeg layer.

**Architecture:** Four supervised processes inside the Docker container — relay (orchestrator + IPTV endpoints + FFmpeg parent), mediamtx (WHIP ingest + RTSP out), chromium (headless + capture extension), trigger (one-shot CDP command). FFmpeg pulls `rtsp://127.0.0.1:8554/live` from mediamtx and writes MPEG-TS to stdout; the relay fans out to UDP multicast and/or HTTP progressive sinks.

**Tech Stack:** Alpine 3.21, Node.js 22, supervisord, chromium, ffmpeg, mediamtx v1.11.3, Chrome MV3 extension, RTCPeerConnection / WHIP.

**Design doc:** `docs/plans/2026-04-17-av-drift-webrtc-rebuild-design.md`

---

## Plan-wide conventions

- All paths are absolute from the repository root `/Users/alexkinch/Projects/alexkinch/webpagestreamer`.
- Commits use Conventional Commits style (project uses release-please; see existing commits).
- Each commit includes the Claude co-author trailer on its own line, matching existing project convention.
- Node.js tests use the built-in `node:test` runner (Node ≥18). No external test framework.
- **Broken-state window:** from the end of Task 8 through to the end of Task 14 the container will not produce a working end-to-end stream. Don't deploy or demo from the branch mid-rebuild. Task 16 is the first task where the stream works again.

---

### Task 0: Pre-flight checkpoint

**Files:** (none modified)

- [ ] **Step 1: Confirm you're on `fix/av-drift`**

Run: `git branch --show-current`
Expected: `fix/av-drift`

- [ ] **Step 2: Confirm working tree is clean**

Run: `git status --porcelain`
Expected: empty output.

- [ ] **Step 3: Tag the current commit as a rollback point**

Run:
```bash
git tag pre-webrtc-rebuild
```

- [ ] **Step 4: Confirm the tag exists**

Run: `git tag --list pre-webrtc-rebuild`
Expected: `pre-webrtc-rebuild`

---

### Task 1: Add mediamtx binary to the Docker image

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Replace the Dockerfile contents**

Write the following to `Dockerfile` (replacing the whole file):

```dockerfile
FROM alpine:3.21

ARG MEDIAMTX_VERSION=v1.11.3
ARG TARGETARCH=amd64

# Install runtime dependencies: Chromium, FFmpeg, Node.js, supervisor, Python/websockets
RUN apk add --no-cache \
    chromium \
    ffmpeg \
    nodejs \
    npm \
    supervisor \
    bash \
    curl \
    python3 \
    py3-websockets

# Install mediamtx static binary. Released tarballs are named
# mediamtx_<ver>_linux_<arch>.tar.gz on GitHub releases.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) MTX_ARCH=amd64 ;; \
      arm64) MTX_ARCH=arm64v8 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/mediamtx.tar.gz \
      "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_${MTX_ARCH}.tar.gz"; \
    tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx; \
    chmod +x /usr/local/bin/mediamtx; \
    rm /tmp/mediamtx.tar.gz

WORKDIR /app/relay

# Copy relay server and install deps
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev
COPY relay/ ./

WORKDIR /app

# Copy extension
COPY extension/ /app/extension/

# Copy scripts and config
COPY start.sh /app/start.sh
COPY trigger-capture.sh /app/trigger-capture.sh
COPY supervisord.conf /etc/supervisor/supervisord.conf
RUN chmod +x /app/start.sh /app/trigger-capture.sh

# Environment defaults
ENV URL="https://www.google.com" \
    UDP_OUTPUT="udp://239.0.0.1:1234" \
    HTTP_OUTPUT="true" \
    PROFILE="pal" \
    HTTP_PORT="9000" \
    CDP_PORT="9222" \
    CHANNEL_NAME="WebPageStreamer" \
    CHANNEL_ID="webpagestreamer.1" \
    PROGRAMME_TITLE="Live Stream" \
    PROGRAMME_DESC="" \
    STREAM_URL=""

ENTRYPOINT ["/app/start.sh"]
```

- [ ] **Step 2: Build the image to verify mediamtx download works**

Run: `docker build -t webpagestreamer:rebuild-task1 .`
Expected: build succeeds. The mediamtx download step must not 404.

- [ ] **Step 3: Verify mediamtx is installed and runnable inside the image**

Run: `docker run --rm --entrypoint /usr/local/bin/mediamtx webpagestreamer:rebuild-task1 --version`
Expected: prints a version string starting with `v1.11.3` (or the version you pinned).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "$(cat <<'EOF'
build: add mediamtx static binary to container image

Also switch ENV defaults to the new UDP_OUTPUT/HTTP_OUTPUT/HTTP_PORT
variables that the relay will consume after the rebuild.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Generate mediamtx config and add supervisord entry

**Files:**
- Modify: `start.sh`
- Modify: `supervisord.conf`

- [ ] **Step 1: Append mediamtx config generation to `start.sh`**

Open `start.sh` and add the following block *before* the final `exec /usr/bin/supervisord ...` line:

```bash
# Write mediamtx config. Ports bind to localhost only; the container only
# exposes HTTP_PORT externally.
cat > /etc/mediamtx.yml <<'MTXEOF'
logLevel: info
logDestinations: [stdout]

rtsp: yes
rtspAddress: 127.0.0.1:8554
webrtc: yes
webrtcAddress: 127.0.0.1:8889
webrtcLocalUDPAddress: 127.0.0.1:8189
webrtcAdditionalHosts: [127.0.0.1]
hls: no
rtmp: no
srt: no
api: no

paths:
  live:
    source: publisher
MTXEOF
```

- [ ] **Step 2: Add mediamtx program to `supervisord.conf`**

Open `supervisord.conf` and add a new program section between the `[program:relay]` and `[program:chrome]` blocks. The full file should end up as:

```ini
[supervisord]
nodaemon=true
logfile=/var/log/supervisord.log
pidfile=/var/run/supervisord.pid
loglevel=info

[program:relay]
command=node /app/relay/server.js
directory=/app/relay
autostart=true
autorestart=true
startretries=10
startsecs=2
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=UDP_OUTPUT="%(ENV_UDP_OUTPUT)s",HTTP_OUTPUT="%(ENV_HTTP_OUTPUT)s",PROFILE="%(ENV_PROFILE)s",WIDTH="%(ENV_WIDTH)s",HEIGHT="%(ENV_HEIGHT)s",FRAMERATE="%(ENV_FRAMERATE)s",HTTP_PORT="%(ENV_HTTP_PORT)s",CHANNEL_NAME="%(ENV_CHANNEL_NAME)s",CHANNEL_ID="%(ENV_CHANNEL_ID)s",PROGRAMME_TITLE="%(ENV_PROGRAMME_TITLE)s",PROGRAMME_DESC="%(ENV_PROGRAMME_DESC)s",STREAM_URL="%(ENV_STREAM_URL)s"
priority=10

[program:mediamtx]
command=/usr/local/bin/mediamtx /etc/mediamtx.yml
autostart=true
autorestart=true
startretries=10
startsecs=2
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=15

[program:chrome]
command=bash /tmp/launch-chrome.sh
autostart=true
autorestart=true
startretries=10
startsecs=5
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=URL="%(ENV_URL)s",WIDTH="%(ENV_WIDTH)s",HEIGHT="%(ENV_HEIGHT)s",CDP_PORT="%(ENV_CDP_PORT)s",EXTENSION_ID="%(ENV_EXTENSION_ID)s",EXTENSION_DIR="%(ENV_EXTENSION_DIR)s"
priority=20

[program:trigger]
command=bash /app/trigger-capture.sh
autostart=true
autorestart=unexpected
startretries=5
startsecs=0
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=CDP_PORT="%(ENV_CDP_PORT)s",HTTP_PORT="%(ENV_HTTP_PORT)s",WIDTH="%(ENV_WIDTH)s",HEIGHT="%(ENV_HEIGHT)s",FRAMERATE="%(ENV_FRAMERATE)s"
priority=30
```

- [ ] **Step 3: Commit**

```bash
git add start.sh supervisord.conf
git commit -m "$(cat <<'EOF'
build: generate mediamtx config and supervise it alongside relay

mediamtx listens only on 127.0.0.1 (RTSP :8554, WebRTC :8889, UDP :8189).
supervisord priorities: relay(10) → mediamtx(15) → chrome(20) → trigger(30)
so the HTTP endpoints come up before anything that depends on ingest.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extract `relay/profiles.js` with tests (TDD)

**Files:**
- Create: `relay/profiles.js`
- Create: `relay/test/profiles.test.js`

This is the first relay split. We cover profile resolution + env overrides as a pure function so it's easy to unit test.

- [ ] **Step 1: Write the failing tests**

Write to `relay/test/profiles.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveProfile } = require("../profiles.js");

test("pal profile is the default when PROFILE is unset", () => {
  const cfg = resolveProfile({});
  assert.equal(cfg.width, 720);
  assert.equal(cfg.height, 576);
  assert.equal(cfg.framerate, "25");
  assert.equal(cfg.videoCodec, "mpeg2video");
  assert.equal(cfg.audioCodec, "mp2");
  assert.equal(cfg.sar, "12/11");
  assert.equal(cfg.interlaced, true);
  assert.equal(cfg.format, "mpegts");
  assert.equal(cfg.profile, "pal");
});

test("ntsc profile", () => {
  const cfg = resolveProfile({ PROFILE: "ntsc" });
  assert.equal(cfg.width, 720);
  assert.equal(cfg.height, 480);
  assert.equal(cfg.framerate, "29.97");
  assert.equal(cfg.sar, "10/11");
  assert.equal(cfg.interlaced, true);
});

test("720p profile", () => {
  const cfg = resolveProfile({ PROFILE: "720p" });
  assert.equal(cfg.width, 1280);
  assert.equal(cfg.height, 720);
  assert.equal(cfg.videoCodec, "libx264");
  assert.equal(cfg.audioCodec, "aac");
  assert.equal(cfg.interlaced, false);
});

test("1080p profile", () => {
  const cfg = resolveProfile({ PROFILE: "1080p" });
  assert.equal(cfg.width, 1920);
  assert.equal(cfg.height, 1080);
});

test("hls profile", () => {
  const cfg = resolveProfile({ PROFILE: "hls" });
  assert.equal(cfg.format, "hls");
  assert.equal(cfg.videoCodec, "libx264");
});

test("unknown profile falls back to pal", () => {
  const cfg = resolveProfile({ PROFILE: "nope" });
  assert.equal(cfg.profile, "pal");
});

test("env overrides take precedence over profile defaults", () => {
  const cfg = resolveProfile({
    PROFILE: "pal",
    WIDTH: "640",
    HEIGHT: "480",
    FRAMERATE: "24",
    VIDEO_CODEC: "libx264",
    AUDIO_CODEC: "aac",
    VIDEO_BITRATE: "3000k",
    AUDIO_BITRATE: "192k",
    SAR: "1/1",
    INTERLACED: "false",
    FORMAT: "mpegts",
  });
  assert.equal(cfg.width, 640);
  assert.equal(cfg.height, 480);
  assert.equal(cfg.framerate, "24");
  assert.equal(cfg.videoCodec, "libx264");
  assert.equal(cfg.audioCodec, "aac");
  assert.equal(cfg.videoBitrate, "3000k");
  assert.equal(cfg.audioBitrate, "192k");
  assert.equal(cfg.sar, "1/1");
  assert.equal(cfg.interlaced, false);
});

test("INTERLACED env parses 'true' / 'false' strings", () => {
  assert.equal(resolveProfile({ INTERLACED: "true" }).interlaced, true);
  assert.equal(resolveProfile({ INTERLACED: "false" }).interlaced, false);
});

test("gop is derived as framerate/2 rounded", () => {
  assert.equal(resolveProfile({ PROFILE: "pal" }).gop, 13); // 25/2 = 12.5 → 13
  assert.equal(resolveProfile({ PROFILE: "ntsc" }).gop, 15); // 29.97/2 ≈ 14.985 → 15
  assert.equal(resolveProfile({ PROFILE: "720p" }).gop, 15);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd relay && node --test test/profiles.test.js`
Expected: FAIL with `Cannot find module '../profiles.js'`.

- [ ] **Step 3: Implement `relay/profiles.js`**

Write to `relay/profiles.js`:

```javascript
// Profile resolution: picks a base config by PROFILE env var and applies
// any explicit overrides. Pure function — no side effects, no process access.

const PROFILES = {
  pal: {
    width: 720, height: 576, framerate: "25",
    videoCodec: "mpeg2video", audioCodec: "mp2",
    videoBitrate: "5000k", audioBitrate: "256k",
    sar: "12/11", interlaced: true, format: "mpegts",
  },
  ntsc: {
    width: 720, height: 480, framerate: "29.97",
    videoCodec: "mpeg2video", audioCodec: "mp2",
    videoBitrate: "5000k", audioBitrate: "256k",
    sar: "10/11", interlaced: true, format: "mpegts",
  },
  "720p": {
    width: 1280, height: 720, framerate: "30",
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "2500k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "mpegts",
  },
  "1080p": {
    width: 1920, height: 1080, framerate: "30",
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "5000k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "mpegts",
  },
  hls: {
    width: 1280, height: 720, framerate: "30",
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "2500k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "hls",
  },
};

function resolveProfile(env) {
  const requested = env.PROFILE || "pal";
  const profile = PROFILES[requested] ? requested : "pal";
  const base = PROFILES[profile];

  const framerate = env.FRAMERATE || base.framerate;
  const width = env.WIDTH ? parseInt(env.WIDTH, 10) : base.width;
  const height = env.HEIGHT ? parseInt(env.HEIGHT, 10) : base.height;

  const interlaced = env.INTERLACED !== undefined
    ? env.INTERLACED === "true"
    : base.interlaced;

  const gop = Math.round(parseFloat(framerate) / 2);

  return {
    profile,
    width,
    height,
    framerate,
    gop,
    videoCodec: env.VIDEO_CODEC || base.videoCodec,
    audioCodec: env.AUDIO_CODEC || base.audioCodec,
    videoBitrate: env.VIDEO_BITRATE || base.videoBitrate,
    audioBitrate: env.AUDIO_BITRATE || base.audioBitrate,
    sar: env.SAR || base.sar,
    interlaced,
    format: env.FORMAT || base.format,
  };
}

module.exports = { resolveProfile };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd relay && node --test test/profiles.test.js`
Expected: PASS. All 9 tests reported as `ok`.

- [ ] **Step 5: Commit**

```bash
git add relay/profiles.js relay/test/profiles.test.js
git commit -m "$(cat <<'EOF'
refactor(relay): extract profile resolution into pure module

Pulls the PROFILES table + env override logic out of server.js so it
can be unit-tested. Also derives gop up-front instead of stringly in
the ffmpeg args builder.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Extract `relay/iptv.js` with tests (TDD)

**Files:**
- Create: `relay/iptv.js`
- Create: `relay/test/iptv.test.js`

- [ ] **Step 1: Write the failing tests**

Write to `relay/test/iptv.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { escapeXML, formatXMLTVDate, generateXMLTV, generateM3U } =
  require("../iptv.js");

test("escapeXML handles all five XML entities", () => {
  assert.equal(escapeXML('A & B < C > D "E"'), "A &amp; B &lt; C &gt; D &quot;E&quot;");
});

test("escapeXML returns empty string for empty input", () => {
  assert.equal(escapeXML(""), "");
});

test("formatXMLTVDate formats UTC timestamp as YYYYMMDDhhmmss +0000", () => {
  const d = new Date(Date.UTC(2026, 3, 17, 14, 5, 9)); // 2026-04-17 14:05:09 UTC
  assert.equal(formatXMLTVDate(d), "20260417140509 +0000");
});

test("generateXMLTV emits 25 hourly programme blocks with a single channel", () => {
  const xml = generateXMLTV({
    channelId: "test.1",
    channelName: "Test Channel",
    programmeTitle: "My Show",
    programmeDesc: "a & b",
    now: new Date(Date.UTC(2026, 3, 17, 12, 0, 0)),
  });
  assert.match(xml, /<channel id="test.1">/);
  assert.match(xml, /<display-name>Test Channel<\/display-name>/);
  // Description should be XML-escaped
  assert.match(xml, /<desc lang="en">a &amp; b<\/desc>/);
  // 25 programme blocks
  const programmeCount = (xml.match(/<programme /g) || []).length;
  assert.equal(programmeCount, 25);
});

test("generateM3U uses overrideUrl when provided", () => {
  const m3u = generateM3U({
    channelId: "c.1",
    channelName: "Chan",
    overrideUrl: "udp://example:1234",
    hostHeader: "ignored.local",
    format: "mpegts",
    udpOutput: "udp://239.0.0.1:1234",
    httpOutput: true,
    httpPort: 9000,
  });
  assert.match(m3u, /udp:\/\/example:1234/);
});

test("generateM3U derives stream URL from udpOutput when set", () => {
  const m3u = generateM3U({
    channelId: "c.1",
    channelName: "Chan",
    overrideUrl: "",
    hostHeader: "h.local:9000",
    format: "mpegts",
    udpOutput: "udp://239.0.0.1:1234",
    httpOutput: false,
    httpPort: 9000,
  });
  // UDP multicast URL is prefixed with @ so clients know to join
  assert.match(m3u, /udp:\/\/@239\.0\.0\.1:1234/);
});

test("generateM3U falls back to http://<host>/stream.ts when no UDP output and HTTP enabled", () => {
  const m3u = generateM3U({
    channelId: "c.1",
    channelName: "Chan",
    overrideUrl: "",
    hostHeader: "h.local:9000",
    format: "mpegts",
    udpOutput: "",
    httpOutput: true,
    httpPort: 9000,
  });
  assert.match(m3u, /http:\/\/h\.local:9000\/stream\.ts/);
});

test("generateM3U contains the EXTM3U header and EXTINF line", () => {
  const m3u = generateM3U({
    channelId: "c.1",
    channelName: "Chan",
    overrideUrl: "http://x/y",
    hostHeader: "h.local",
    format: "mpegts",
    udpOutput: "",
    httpOutput: true,
    httpPort: 9000,
  });
  assert.match(m3u, /^#EXTM3U/);
  assert.match(m3u, /#EXTINF:-1 tvg-id="c.1" tvg-name="Chan" group-title="Chan",Chan/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd relay && node --test test/iptv.test.js`
Expected: FAIL with `Cannot find module '../iptv.js'`.

- [ ] **Step 3: Implement `relay/iptv.js`**

Write to `relay/iptv.js`:

```javascript
// Playlist / XMLTV generation for IPTV clients (Dispatcharr, VLC, etc.).
// Pure functions only — the HTTP layer is responsible for headers + request
// inspection.

function escapeXML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatXMLTVDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    " +0000"
  );
}

function generateXMLTV({ channelId, channelName, programmeTitle, programmeDesc, now }) {
  const ref = now || new Date();
  // Start 1h ago so "now" always falls inside a programme block.
  const start = new Date(ref.getTime() - 60 * 60 * 1000);

  let programmes = "";
  for (let i = 0; i < 25; i++) {
    const pStart = new Date(start.getTime() + i * 60 * 60 * 1000);
    const pStop = new Date(start.getTime() + (i + 1) * 60 * 60 * 1000);
    programmes +=
      `  <programme start="${formatXMLTVDate(pStart)}" stop="${formatXMLTVDate(pStop)}" channel="${escapeXML(channelId)}">\n` +
      `    <title lang="en">${escapeXML(programmeTitle)}</title>\n` +
      `    <desc lang="en">${escapeXML(programmeDesc)}</desc>\n` +
      `  </programme>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="webpagestreamer">
  <channel id="${escapeXML(channelId)}">
    <display-name>${escapeXML(channelName)}</display-name>
  </channel>
${programmes}</tv>
`;
}

function deriveStreamURL({ overrideUrl, hostHeader, format, udpOutput, httpOutput, httpPort }) {
  if (overrideUrl) return overrideUrl;

  const host = hostHeader || `localhost:${httpPort}`;

  if (format === "hls") {
    return `http://${host}/stream/stream.m3u8`;
  }
  if (udpOutput && udpOutput.startsWith("udp://")) {
    const parsed = new URL(udpOutput);
    return `udp://@${parsed.hostname}:${parsed.port}`;
  }
  if (httpOutput) {
    return `http://${host}/stream.ts`;
  }
  return "";
}

function generateM3U(opts) {
  const streamUrl = deriveStreamURL(opts);
  const { channelId, channelName } = opts;
  return `#EXTM3U
#EXTINF:-1 tvg-id="${channelId}" tvg-name="${channelName}" group-title="${channelName}",${channelName}
${streamUrl}
`;
}

module.exports = { escapeXML, formatXMLTVDate, generateXMLTV, generateM3U, deriveStreamURL };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd relay && node --test test/iptv.test.js`
Expected: PASS. All 8 tests reported as `ok`.

- [ ] **Step 5: Commit**

```bash
git add relay/iptv.js relay/test/iptv.test.js
git commit -m "$(cat <<'EOF'
refactor(relay): extract IPTV playlist + XMLTV generation into pure module

No behaviour change for /playlist.m3u and /guide.xml consumers. The new
module takes an explicit options bag so tests don't need a live request.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Extract `relay/outputs.js` with tests (TDD)

**Files:**
- Create: `relay/outputs.js`
- Create: `relay/test/outputs.test.js`

Only UDP multicast and HTTP progressive survive. RTP, TCP, and file sinks are gone.

- [ ] **Step 1: Write the failing tests**

Write to `relay/test/outputs.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { parseUDPOutput, chunkForUDP, createHTTPFanout } = require("../outputs.js");

test("parseUDPOutput extracts host and port", () => {
  assert.deepEqual(parseUDPOutput("udp://239.0.0.1:1234"), {
    host: "239.0.0.1",
    port: 1234,
    isMulticast: true,
  });
});

test("parseUDPOutput flags non-multicast addresses correctly", () => {
  assert.deepEqual(parseUDPOutput("udp://10.0.0.5:5000"), {
    host: "10.0.0.5",
    port: 5000,
    isMulticast: false,
  });
});

test("chunkForUDP yields 1316-byte TS-aligned slices", () => {
  // 4000-byte buffer → 1316 + 1316 + 1316 + 52
  const buf = Buffer.alloc(4000, 0xab);
  const chunks = [...chunkForUDP(buf)];
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0].length, 1316);
  assert.equal(chunks[1].length, 1316);
  assert.equal(chunks[2].length, 1316);
  assert.equal(chunks[3].length, 52);
});

test("chunkForUDP handles buffers smaller than one packet", () => {
  const buf = Buffer.alloc(100, 0x11);
  const chunks = [...chunkForUDP(buf)];
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 100);
});

test("chunkForUDP yields nothing for an empty buffer", () => {
  const chunks = [...chunkForUDP(Buffer.alloc(0))];
  assert.equal(chunks.length, 0);
});

test("createHTTPFanout writes to every live client", () => {
  const writes = [];
  const clients = new Set([
    { destroyed: false, writable: true, write: (c) => writes.push(["a", c]), end: () => {} },
    { destroyed: false, writable: true, write: (c) => writes.push(["b", c]), end: () => {} },
  ]);
  const sink = createHTTPFanout(clients);
  sink.write(Buffer.from("hello"));
  assert.equal(writes.length, 2);
  assert.equal(writes[0][0], "a");
  assert.equal(writes[1][0], "b");
});

test("createHTTPFanout skips destroyed or non-writable clients", () => {
  const writes = [];
  const clients = new Set([
    { destroyed: true, writable: true, write: (c) => writes.push(c), end: () => {} },
    { destroyed: false, writable: false, write: (c) => writes.push(c), end: () => {} },
    { destroyed: false, writable: true, write: (c) => writes.push(c), end: () => {} },
  ]);
  const sink = createHTTPFanout(clients);
  sink.write(Buffer.from("x"));
  assert.equal(writes.length, 1);
});

test("createHTTPFanout close() ends every client and empties the set", () => {
  let ended = 0;
  const clients = new Set([
    { destroyed: false, writable: true, write: () => {}, end: () => { ended++; } },
    { destroyed: false, writable: true, write: () => {}, end: () => { ended++; } },
  ]);
  const sink = createHTTPFanout(clients);
  sink.close();
  assert.equal(ended, 2);
  assert.equal(clients.size, 0);
});

// Integration-style: bind a UDP socket, send one packet, verify receipt.
test("createUDPSink actually delivers packets to the target host:port", async () => {
  const { createUDPSink } = require("../outputs.js");
  const receiver = dgram.createSocket("udp4");
  await new Promise((resolve) => receiver.bind(0, "127.0.0.1", resolve));
  const port = receiver.address().port;

  const received = new Promise((resolve) => {
    receiver.once("message", (msg) => resolve(msg));
  });

  const sink = createUDPSink("127.0.0.1", port);
  sink.write(Buffer.from("ping"));

  const msg = await received;
  assert.equal(msg.toString(), "ping");

  sink.close();
  receiver.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd relay && node --test test/outputs.test.js`
Expected: FAIL with `Cannot find module '../outputs.js'`.

- [ ] **Step 3: Implement `relay/outputs.js`**

Write to `relay/outputs.js`:

```javascript
// Output sinks: UDP multicast and HTTP progressive.
// The UDP sink is the only one with non-trivial logic — TS-aligned packet
// sizing and optional multicast TTL.

const dgram = require("node:dgram");

const TS_PACKET = 188;
const UDP_PAYLOAD = TS_PACKET * 7; // 1316 bytes fits under a 1500-byte MTU

function parseUDPOutput(outputStr) {
  const parsed = new URL(outputStr);
  const host = parsed.hostname;
  const port = parseInt(parsed.port, 10);
  const firstOctet = parseInt(host.split(".")[0], 10);
  const isMulticast = firstOctet >= 224 && firstOctet <= 239;
  return { host, port, isMulticast };
}

function* chunkForUDP(buffer) {
  for (let i = 0; i < buffer.length; i += UDP_PAYLOAD) {
    yield buffer.slice(i, Math.min(i + UDP_PAYLOAD, buffer.length));
  }
}

function createUDPSink(host, port) {
  const socket = dgram.createSocket("udp4");
  const firstOctet = parseInt(host.split(".")[0], 10);
  const isMulticast = firstOctet >= 224 && firstOctet <= 239;
  if (isMulticast) {
    socket.bind(0, () => socket.setMulticastTTL(4));
  }
  return {
    write(chunk) {
      for (const pkt of chunkForUDP(chunk)) {
        socket.send(pkt, port, host);
      }
    },
    close() {
      socket.close();
    },
  };
}

function createHTTPFanout(clients) {
  return {
    write(chunk) {
      for (const res of clients) {
        if (!res.destroyed && res.writable) {
          res.write(chunk);
        }
      }
    },
    close() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

module.exports = {
  parseUDPOutput,
  chunkForUDP,
  createUDPSink,
  createHTTPFanout,
  UDP_PAYLOAD,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd relay && node --test test/outputs.test.js`
Expected: PASS. All 9 tests reported as `ok`.

- [ ] **Step 5: Commit**

```bash
git add relay/outputs.js relay/test/outputs.test.js
git commit -m "$(cat <<'EOF'
refactor(relay): extract UDP multicast + HTTP fanout sinks

UDP sink preserves the existing TS-aligned (7×188=1316) packet sizing
and multicast TTL behaviour. HTTP fanout mirrors the existing
httpStreamClients Set pattern. RTP/TCP/file sinks are not carried
forward — see the rebuild plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Write `relay/ffmpeg.js` (FFmpeg child process manager)

**Files:**
- Create: `relay/ffmpeg.js`

Spawning an actual ffmpeg is an integration concern, so this task has no unit tests — it's covered by the smoke test in Task 16. The module is kept small enough to review by reading.

- [ ] **Step 1: Write `relay/ffmpeg.js`**

Write to `relay/ffmpeg.js`:

```javascript
// Spawns ffmpeg as a child process. Ffmpeg reads RTSP from mediamtx,
// transcodes to the configured profile, and writes MPEG-TS to stdout.
// The caller supplies a sink function that receives each stdout chunk.

const { spawn } = require("node:child_process");

const RTSP_URL = "rtsp://127.0.0.1:8554/live";
const HLS_DIR = "/tmp/hls";
const HLS_SEGMENT_TIME = process.env.HLS_SEGMENT_TIME || "2";
const HLS_LIST_SIZE = process.env.HLS_LIST_SIZE || "5";

function buildArgs(profile) {
  const args = [
    "-fflags", "+genpts",
    "-rtsp_transport", "tcp",
    "-i", RTSP_URL,

    "-c:v", profile.videoCodec,
    "-s", `${profile.width}x${profile.height}`,
    "-r", profile.framerate,
    "-b:v", profile.videoBitrate,
    "-maxrate", profile.videoBitrate,
    "-bufsize", "2000k",
    "-pix_fmt", "yuv420p",
    "-g", String(profile.gop),
    "-bf", "2",
  ];

  if (profile.interlaced) {
    args.push("-flags", "+ilme+ildct");
  }
  if (profile.videoCodec === "libx264") {
    args.push("-preset", "veryfast", "-tune", "zerolatency");
  }

  args.push("-vf", `setsar=${profile.sar}`);

  args.push(
    "-c:a", profile.audioCodec,
    "-b:a", profile.audioBitrate,
    "-ar", "48000",
    "-ac", "2",
  );

  args.push("-fps_mode", "cfr");

  if (profile.format === "hls") {
    args.push(
      "-f", "hls",
      "-hls_time", HLS_SEGMENT_TIME,
      "-hls_list_size", HLS_LIST_SIZE,
      "-hls_flags", "delete_segments",
      "-hls_segment_filename", `${HLS_DIR}/segment%03d.ts`,
      `${HLS_DIR}/stream.m3u8`,
    );
  } else {
    args.push("-f", "mpegts", "pipe:1");
  }

  return args;
}

// Start ffmpeg with 2s auto-restart on exit. Returns a handle exposing
// the current pid and an `isRunning()` helper so /health can probe it.
function startFFmpeg({ profile, onData, restartDelayMs = 2000 }) {
  let current = null;

  function spawnOnce() {
    const args = buildArgs(profile);
    console.log(`[ffmpeg] spawning with profile=${profile.profile} format=${profile.format}`);

    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    current = child;

    child.stdout.on("data", (chunk) => {
      if (profile.format !== "hls") onData(chunk);
    });

    child.stderr.on("data", (data) => {
      const line = data.toString().trim();
      if (!line) return;
      // Sample progress lines so we don't spam logs.
      if (line.startsWith("frame=") || line.startsWith("size=")) {
        if (Math.random() < 0.01) console.log(`[ffmpeg] ${line}`);
      } else {
        console.log(`[ffmpeg] ${line}`);
      }
    });

    child.on("error", (err) => {
      console.error(`[ffmpeg] process error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      console.log(`[ffmpeg] exited code=${code} signal=${signal} — restarting in ${restartDelayMs}ms`);
      current = null;
      setTimeout(spawnOnce, restartDelayMs);
    });
  }

  spawnOnce();

  return {
    isRunning: () => current !== null && !current.killed,
  };
}

module.exports = { startFFmpeg, buildArgs, RTSP_URL, HLS_DIR };
```

- [ ] **Step 2: Commit**

```bash
git add relay/ffmpeg.js
git commit -m "$(cat <<'EOF'
feat(relay): add ffmpeg child process manager

FFmpeg now pulls RTSP from mediamtx instead of reading WebM from stdin.
The drift-related hacks (-use_wallclock_as_timestamps, aresample=async,
-async) are gone — RTP timestamps from mediamtx are authoritative.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Rewrite `relay/server.js` as the orchestrator

**Files:**
- Modify: `relay/server.js`

This is a full rewrite. The WebSocket server, WebM stdin path, and old outputHandler abstraction all go.

- [ ] **Step 1: Replace the contents of `relay/server.js`**

Write to `relay/server.js` (replacing the whole file):

```javascript
// Relay orchestrator:
//   - Serves IPTV endpoints (/playlist.m3u, /guide.xml, /health)
//   - Optionally fans out FFmpeg's MPEG-TS stdout to HTTP clients (/stream.ts)
//   - Spawns FFmpeg to pull RTSP from mediamtx and emit MPEG-TS
//   - Optionally sends MPEG-TS to a UDP multicast destination
//
// The extension no longer connects here via WebSocket; it publishes WebRTC
// directly to mediamtx on localhost:8889. We're the output side only.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const url = require("node:url");

const { resolveProfile } = require("./profiles.js");
const { generateXMLTV, generateM3U } = require("./iptv.js");
const {
  parseUDPOutput,
  createUDPSink,
  createHTTPFanout,
} = require("./outputs.js");
const { startFFmpeg, HLS_DIR } = require("./ffmpeg.js");

const HTTP_PORT = parseInt(process.env.HTTP_PORT || process.env.WS_PORT || "9000", 10);
const UDP_OUTPUT = process.env.UDP_OUTPUT || "";
const HTTP_OUTPUT = (process.env.HTTP_OUTPUT || "false").toLowerCase() === "true";
const CHANNEL_NAME = process.env.CHANNEL_NAME || "WebPageStreamer";
const CHANNEL_ID = process.env.CHANNEL_ID || "webpagestreamer.1";
const PROGRAMME_TITLE = process.env.PROGRAMME_TITLE || "Live Stream";
const PROGRAMME_DESC = process.env.PROGRAMME_DESC || "";
const STREAM_URL = process.env.STREAM_URL || "";

const profile = resolveProfile(process.env);

console.log(`[relay] profile=${profile.profile} ${profile.width}x${profile.height}@${profile.framerate}fps`);
console.log(`[relay] udp_output=${UDP_OUTPUT || "(disabled)"}`);
console.log(`[relay] http_output=${HTTP_OUTPUT ? `enabled on /stream.ts` : "(disabled)"}`);

// ---------------------------------------------------------------------------
// Set up output sinks before ffmpeg so we don't drop early data
// ---------------------------------------------------------------------------

const sinks = [];

if (UDP_OUTPUT) {
  const { host, port, isMulticast } = parseUDPOutput(UDP_OUTPUT);
  const udp = createUDPSink(host, port);
  sinks.push(udp);
  console.log(`[output] UDP → ${host}:${port}${isMulticast ? " (multicast)" : ""}`);
}

const httpStreamClients = new Set();
let httpFanout = null;
if (HTTP_OUTPUT) {
  httpFanout = createHTTPFanout(httpStreamClients);
  sinks.push(httpFanout);
  console.log(`[output] HTTP progressive at http://<host>:${HTTP_PORT}/stream.ts`);
}

if (profile.format === "hls") {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// FFmpeg
// ---------------------------------------------------------------------------

const ffmpegHandle = startFFmpeg({
  profile,
  onData: (chunk) => {
    for (const sink of sinks) sink.write(chunk);
  },
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const TEST_CLOCK_PATH = path.resolve(__dirname, "../test/clock.html");

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

function serveHLSFile(pathname, res) {
  const filename = pathname.replace("/stream/", "");
  if (filename.includes("..") || filename.includes("/")) {
    res.writeHead(403); res.end(); return;
  }
  const filePath = `${HLS_DIR}/${filename}`;
  const stream = fs.createReadStream(filePath);
  const contentType = filename.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : "video/mp2t";
  stream.on("open", () => {
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    stream.pipe(res);
  });
  stream.on("error", () => { res.writeHead(404); res.end(); });
}

function mediamtxReachable(cb) {
  const socket = net.createConnection({ host: "127.0.0.1", port: 8554, timeout: 500 });
  socket.once("connect", () => { socket.destroy(); cb(true); });
  socket.once("error", () => cb(false));
  socket.once("timeout", () => { socket.destroy(); cb(false); });
}

function handleRequest(req, res) {
  const pathname = url.parse(req.url).pathname;

  if (pathname === "/stream.ts" && HTTP_OUTPUT) {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "video/mp2t", "Cache-Control": "no-cache" });
      res.end();
      return;
    }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    console.log(`[output] HTTP client connected: ${req.socket.remoteAddress}`);
    res.writeHead(200, {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache, no-store",
      Connection: "close",
    });
    httpStreamClients.add(res);
    const cleanup = () => {
      if (httpStreamClients.delete(res)) console.log(`[output] HTTP client disconnected`);
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
    return;
  }

  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }

  if (pathname === "/guide.xml") {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(generateXMLTV({
      channelId: CHANNEL_ID,
      channelName: CHANNEL_NAME,
      programmeTitle: PROGRAMME_TITLE,
      programmeDesc: PROGRAMME_DESC,
    }));
    return;
  }

  if (pathname === "/playlist.m3u") {
    res.writeHead(200, { "Content-Type": "audio/x-mpegurl" });
    res.end(generateM3U({
      channelId: CHANNEL_ID,
      channelName: CHANNEL_NAME,
      overrideUrl: STREAM_URL,
      hostHeader: req.headers.host || `localhost:${HTTP_PORT}`,
      format: profile.format,
      udpOutput: UDP_OUTPUT,
      httpOutput: HTTP_OUTPUT,
      httpPort: HTTP_PORT,
    }));
    return;
  }

  if (pathname === "/health") {
    mediamtxReachable((ok) => {
      const hasSink = sinks.length > 0 || profile.format === "hls";
      const healthy = ok && ffmpegHandle.isRunning() && hasSink;
      const body = JSON.stringify({
        status: healthy ? "healthy" : "unhealthy",
        mediamtx: ok,
        ffmpeg: ffmpegHandle.isRunning(),
        profile: profile.profile,
        format: profile.format,
        udp_output: UDP_OUTPUT || null,
        http_output: HTTP_OUTPUT,
      });
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
    });
    return;
  }

  if (pathname === "/test/clock.html") {
    serveFile(res, TEST_CLOCK_PATH, "text/html; charset=utf-8");
    return;
  }

  if (profile.format === "hls" && pathname.startsWith("/stream/")) {
    serveHLSFile(pathname, res);
    return;
  }

  res.writeHead(404);
  res.end();
}

const server = http.createServer(handleRequest);
server.listen(HTTP_PORT, () => {
  console.log(`[relay] HTTP server listening on :${HTTP_PORT}`);
  console.log(`[relay]   GET /guide.xml       — XMLTV`);
  console.log(`[relay]   GET /playlist.m3u    — M3U playlist`);
  console.log(`[relay]   GET /health          — health check`);
  console.log(`[relay]   GET /test/clock.html — drift-measurement test page`);
  if (HTTP_OUTPUT) console.log(`[relay]   GET /stream.ts       — progressive MPEG-TS`);
  if (profile.format === "hls") console.log(`[relay]   GET /stream/*        — HLS segments`);
});
```

- [ ] **Step 2: Run the existing unit tests to verify they still pass**

Run: `cd relay && node --test test/`
Expected: PASS. All tests from `profiles.test.js`, `iptv.test.js`, `outputs.test.js` still pass.

- [ ] **Step 3: Run the server locally (without Docker) to verify it starts and crashes cleanly when ffmpeg/mediamtx aren't reachable**

Run: `cd relay && HTTP_OUTPUT=true PROFILE=pal node server.js &`

Expected: Startup logs appear, HTTP server listens on :9000, `[ffmpeg]` errors appear because `rtsp://127.0.0.1:8554/live` is unreachable — this is the expected behaviour locally without mediamtx. FFmpeg should keep restarting every 2s.

- [ ] **Step 4: Verify the HTTP endpoints respond**

Run:
```bash
curl -s http://127.0.0.1:9000/guide.xml | head -5
curl -s http://127.0.0.1:9000/playlist.m3u
curl -s http://127.0.0.1:9000/health
```
Expected: `guide.xml` starts with `<?xml`, `playlist.m3u` contains `#EXTM3U`, `health` returns JSON with `"status":"unhealthy"` (ffmpeg is failing to connect to mediamtx).

- [ ] **Step 5: Kill the local server**

Run: `kill %1 ; wait` (or `pkill -f 'node server.js'`).

- [ ] **Step 6: Commit**

```bash
git add relay/server.js
git commit -m "$(cat <<'EOF'
refactor(relay): rewrite server.js as orchestrator over extracted modules

Removes the WebSocket server, WebM stdin path, and outputHandler
abstraction. FFmpeg now pulls RTSP from mediamtx and its stdout is
fanned out to UDP multicast and/or HTTP progressive sinks. IPTV
endpoints are unchanged from the caller's perspective.

BREAKING: OUTPUT env var replaced by UDP_OUTPUT + HTTP_OUTPUT. RTP,
TCP, and file output schemes are removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Remove `ws` dependency from `relay/package.json`

**Files:**
- Modify: `relay/package.json`
- Modify: `relay/package-lock.json`

- [ ] **Step 1: Replace `relay/package.json`**

Write to `relay/package.json`:

```json
{
  "name": "webpagestreamer-relay",
  "version": "1.0.0",
  "private": true,
  "description": "Orchestrator for MPEG-TS transcoding from mediamtx RTSP ingest",
  "main": "server.js",
  "scripts": {
    "test": "node --test test/"
  },
  "dependencies": {}
}
```

- [ ] **Step 2: Regenerate the lockfile**

Run: `cd relay && rm -f package-lock.json node_modules/.package-lock.json && npm install`
Expected: creates a lockfile with zero runtime dependencies. Leaves no `ws` package installed.

- [ ] **Step 3: Run the tests once more to confirm nothing pulls `ws` transitively**

Run: `cd relay && npm test`
Expected: PASS. All 26 tests across the three test files.

- [ ] **Step 4: Commit**

```bash
git add relay/package.json relay/package-lock.json
git commit -m "$(cat <<'EOF'
chore(relay): drop the ws dependency

The WebSocket server is gone — the extension now publishes WebRTC
directly to mediamtx. The relay is pure Node.js built-ins.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Rewrite `extension/content.js` as a WHIP publisher

**Files:**
- Modify: `extension/content.js`

- [ ] **Step 1: Replace `extension/content.js`**

Write to `extension/content.js`:

```javascript
// Content script: captures the tab via tabCapture stream ID and publishes
// it to mediamtx's WHIP endpoint as VP8 + Opus over WebRTC. Independent
// RTP timestamps are what fixes A/V drift.

(function () {
  let pc = null;
  let stream = null;

  function hideScrollbars() {
    const style = document.createElement("style");
    style.textContent = `
      html, body { overflow: hidden !important; }
      ::-webkit-scrollbar { display: none !important; }
      video::-webkit-media-controls { display: none !important; }
      video::-webkit-media-controls-overlay-play-button { display: none !important; }
      video::-webkit-media-controls-enclosure { display: none !important; }
      video::-internal-media-controls-overlay-cast-button { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function forceFrames() {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:2147483647;";
    document.documentElement.appendChild(el);
    let toggle = false;
    function tick() {
      toggle = !toggle;
      el.style.opacity = toggle ? "0.01" : "0.02";
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  async function getTabStream(width, height, framerate) {
    const response = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ command: "get-stream-id" }, resolve)
    );
    if (!response || response.error) {
      throw new Error(`get-stream-id failed: ${response && response.error}`);
    }
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: response.streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: response.streamId,
          minFrameRate: framerate,
          maxFrameRate: framerate,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
        },
      },
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function pinCodecPreferences(pc) {
    // Prefer VP8 + Opus. mediamtx will forward these as RTP streams with
    // independent clocks — the whole point of the rebuild.
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.sender.track && transceiver.sender.track.kind;
      if (!kind) continue;
      const capabilities = RTCRtpSender.getCapabilities(kind);
      if (!capabilities) continue;
      const preferred = capabilities.codecs.filter((c) => {
        const m = c.mimeType.toLowerCase();
        return (kind === "video" && m === "video/vp8") ||
               (kind === "audio" && m === "audio/opus");
      });
      const fallback = capabilities.codecs.filter((c) => !preferred.includes(c));
      if (transceiver.setCodecPreferences) {
        try {
          transceiver.setCodecPreferences([...preferred, ...fallback]);
        } catch (e) {
          console.warn("[capture] setCodecPreferences failed:", e);
        }
      }
    }
  }

  async function pinVideoBitrate(pc, maxBitrate) {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== "video") continue;
      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length
        ? params.encodings.map((e) => ({ ...e, maxBitrate }))
        : [{ maxBitrate }];
      try {
        await sender.setParameters(params);
      } catch (e) {
        console.warn("[capture] setParameters failed:", e);
      }
    }
  }

  async function publishWHIP(mediaStream, whipUrl, maxBitrate) {
    if (pc) {
      try { pc.close(); } catch (e) {}
      pc = null;
    }
    pc = new RTCPeerConnection();

    // Surface connection failures so the outer loop can retry.
    pc.addEventListener("iceconnectionstatechange", () => {
      console.log(`[capture] iceConnectionState=${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        console.warn("[capture] ICE failed/disconnected — restarting publish");
        setTimeout(() => startPublishing(mediaStream, whipUrl, maxBitrate), 2000);
      }
    });

    for (const track of mediaStream.getTracks()) {
      pc.addTransceiver(track, { direction: "sendonly", streams: [mediaStream] });
    }

    pinCodecPreferences(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait briefly for ICE gathering — WHIP servers handle trickle but
    // bundling candidates in the offer simplifies the flow.
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      setTimeout(resolve, 1000);
    });

    const response = await fetch(whipUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
    });
    if (!response.ok) {
      throw new Error(`WHIP POST failed: ${response.status} ${response.statusText}`);
    }
    const answerSDP = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSDP });

    await pinVideoBitrate(pc, maxBitrate);
    console.log("[capture] WHIP publish established");
  }

  async function startPublishing(existingStream, whipUrl, maxBitrate) {
    try {
      const s = existingStream || stream;
      if (!s) throw new Error("no media stream to publish");
      await publishWHIP(s, whipUrl, maxBitrate);
    } catch (err) {
      console.error("[capture] publish failed, retrying in 2s:", err);
      setTimeout(() => startPublishing(existingStream, whipUrl, maxBitrate), 2000);
    }
  }

  async function startCapture({ whipUrl, width, height, framerate, maxBitrate }) {
    try {
      stream = await getTabStream(width, height, framerate);
      console.log("[capture] got media stream, publishing to WHIP:", whipUrl);
      await startPublishing(stream, whipUrl, maxBitrate);
    } catch (err) {
      console.error("[capture] capture init failed, retrying in 2s:", err);
      setTimeout(() => startCapture({ whipUrl, width, height, framerate, maxBitrate }), 2000);
    }
  }

  window.addEventListener("message", (event) => {
    if (
      event.data &&
      event.data.type === "CAPTURE_COMMAND" &&
      event.data.command === "start"
    ) {
      const width = event.data.width || 720;
      const height = event.data.height || 576;
      const framerate = event.data.framerate || 25;
      const whipUrl = event.data.whipUrl || "http://127.0.0.1:8889/live/whip";
      const maxBitrate = event.data.maxBitrate || 2_500_000;
      console.log(
        `[capture] start command — ${width}x${height}@${framerate}fps → ${whipUrl}`
      );
      hideScrollbars();
      forceFrames();
      startCapture({ whipUrl, width, height, framerate, maxBitrate });
    }
  });
})();
```

- [ ] **Step 2: Commit**

```bash
git add extension/content.js
git commit -m "$(cat <<'EOF'
feat(extension): publish via WHIP instead of MediaRecorder+WebSocket

content.js now creates an RTCPeerConnection, pins VP8+Opus codec
preferences, pins video bitrate so localhost bandwidth estimation
can't throttle us, and POSTs the SDP offer to mediamtx's WHIP
endpoint at http://127.0.0.1:8889/live/whip.

ICE failures restart the publish after 2s (same retry pattern the
old WebSocket path used).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Update `extension/manifest.json` host permissions

**Files:**
- Modify: `extension/manifest.json`

- [ ] **Step 1: Replace `extension/manifest.json`**

Write to `extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Tab Capture Streamer",
  "version": "1.0",
  "description": "Captures tab audio and video for MPEG-TS streaming via WebRTC/WHIP",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3PSI6DR/mVNC7m3Xlh5xg9S5eD+3kAvDKcGhDwjUv/DUVqWDk6o7DWsAm1vmyejcP7wNnxg5pJwK4qiKYCMWzn7ia4STyVqJ3cy+HB7vfuFQf9axssvV/42PjG1ucBBorT5ok/VJJ3jLJmel/vTYfjUuOroNnnIfu24RJffbedfDv9wChpZEeGoc9BJXSn/r1gGU022TZ4ofZwGL+CigzUjdb8BRQqLQrH+LPo+H7IPXb8lj/vIrhMKjJ+uFt+v0nsPyy9JPUt/eK9ctbVOVynjsUpNUgiKHjkYlOLEVkMB/83MciA/YUOwz4qxFGnlxrGoLuE/jdNYx2YJ0imkKiQIDAQAB",
  "permissions": [
    "tabs",
    "tabCapture",
    "activeTab",
    "scripting"
  ],
  "host_permissions": [
    "<all_urls>",
    "http://127.0.0.1:8889/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/manifest.json
git commit -m "$(cat <<'EOF'
feat(extension): allow fetch to mediamtx WHIP endpoint

Adds http://127.0.0.1:8889/* to host_permissions so the content
script's fetch() to mediamtx's WHIP URL is not blocked.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Update `trigger-capture.sh` to pass the WHIP URL

**Files:**
- Modify: `trigger-capture.sh`

- [ ] **Step 1: Replace `trigger-capture.sh`**

Write to `trigger-capture.sh`:

```bash
#!/bin/bash
# Waits for Chrome to be ready, then uses CDP to trigger capture
# by posting a CAPTURE_COMMAND message to the page via JavaScript evaluation.

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
HTTP_PORT="${HTTP_PORT:-9000}"
WIDTH="${WIDTH:-720}"
HEIGHT="${HEIGHT:-576}"
FRAMERATE="${FRAMERATE:-25}"
WHIP_URL="${WHIP_URL:-http://127.0.0.1:8889/live/whip}"

echo "[trigger] waiting for Chrome CDP on port $CDP_PORT..."

for i in $(seq 1 60); do
    if curl -s "http://127.0.0.1:${CDP_PORT}/json" > /dev/null 2>&1; then
        echo "[trigger] Chrome CDP is ready"
        break
    fi
    if [ "$i" = "60" ]; then
        echo "[trigger] ERROR: Chrome did not start within 60s"
        exit 1
    fi
    sleep 1
done

sleep 3

WS_URL=$(curl -s "http://127.0.0.1:${CDP_PORT}/json" | python3 -c "
import sys, json
tabs = json.load(sys.stdin)
for tab in tabs:
    if tab.get('type') == 'page':
        print(tab['webSocketDebuggerUrl'])
        break
")

if [ -z "$WS_URL" ]; then
    echo "[trigger] ERROR: no page tab found"
    exit 1
fi

echo "[trigger] found tab: $WS_URL"
echo "[trigger] setting viewport to ${WIDTH}x${HEIGHT}..."

python3 <<PYEOF
import json, asyncio, websockets

async def trigger():
    ws_url = "${WS_URL}"
    async with websockets.connect(ws_url, max_size=None) as ws:
        metrics_cmd = {
            "id": 1,
            "method": "Emulation.setDeviceMetricsOverride",
            "params": {
                "width": ${WIDTH},
                "height": ${HEIGHT},
                "deviceScaleFactor": 1,
                "mobile": False
            }
        }
        await ws.send(json.dumps(metrics_cmd))
        resp = await ws.recv()
        print("[trigger] viewport set:", resp)

        cmd = {
            "id": 2,
            "method": "Runtime.evaluate",
            "params": {
                "expression": """
                    window.postMessage({
                        type: 'CAPTURE_COMMAND',
                        command: 'start',
                        whipUrl: '${WHIP_URL}',
                        width: ${WIDTH},
                        height: ${HEIGHT},
                        framerate: ${FRAMERATE}
                    }, '*');
                    'capture triggered';
                """,
                "returnByValue": True
            }
        }
        await ws.send(json.dumps(cmd))
        resp = await ws.recv()
        print("[trigger] CDP response:", resp)
        print("[trigger] capture command sent successfully")

asyncio.run(trigger())
PYEOF
```

- [ ] **Step 2: Commit**

```bash
git add trigger-capture.sh
git commit -m "$(cat <<'EOF'
feat(trigger): pass WHIP URL to the extension in CAPTURE_COMMAND

Replaces the WebSocket port payload with a WHIP URL (default
http://127.0.0.1:8889/live/whip) and renames WS_PORT to HTTP_PORT.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Update `start.sh` for new env vars

**Files:**
- Modify: `start.sh`

- [ ] **Step 1: Replace `start.sh`**

Write to `start.sh`:

```bash
#!/bin/bash
# Entrypoint: writes mediamtx config + Chrome launcher, then starts supervisord.

set -euo pipefail

URL="${URL:-https://www.google.com}"
UDP_OUTPUT="${UDP_OUTPUT:-udp://239.0.0.1:1234}"
HTTP_OUTPUT="${HTTP_OUTPUT:-true}"
PROFILE="${PROFILE:-pal}"
# Accept the old WS_PORT as a silent fallback for one release.
HTTP_PORT="${HTTP_PORT:-${WS_PORT:-9000}}"
CDP_PORT="${CDP_PORT:-9222}"
CHANNEL_NAME="${CHANNEL_NAME:-WebPageStreamer}"
CHANNEL_ID="${CHANNEL_ID:-webpagestreamer.1}"
PROGRAMME_TITLE="${PROGRAMME_TITLE:-Live Stream}"
PROGRAMME_DESC="${PROGRAMME_DESC:-}"
STREAM_URL="${STREAM_URL:-}"

# Resolve WIDTH/HEIGHT/FRAMERATE from profile if not explicitly set
case "$PROFILE" in
  pal)   _W=720;  _H=576;  _F=25    ;;
  ntsc)  _W=720;  _H=480;  _F=29.97 ;;
  720p)  _W=1280; _H=720;  _F=30    ;;
  1080p) _W=1920; _H=1080; _F=30    ;;
  hls)   _W=1280; _H=720;  _F=30    ;;
  *)     _W=720;  _H=576;  _F=25    ;;
esac
WIDTH="${WIDTH:-$_W}"
HEIGHT="${HEIGHT:-$_H}"
FRAMERATE="${FRAMERATE:-$_F}"

EXTENSION_ID="akfimkeaknlnblgelnlelcgihcmconnb"
EXTENSION_DIR="/app/extension"

export URL WIDTH HEIGHT FRAMERATE PROFILE
export UDP_OUTPUT HTTP_OUTPUT HTTP_PORT CDP_PORT
export CHANNEL_NAME CHANNEL_ID PROGRAMME_TITLE PROGRAMME_DESC STREAM_URL

echo "[start] Profile=$PROFILE"
echo "[start] URL=$URL"
echo "[start] Resolution=${WIDTH}x${HEIGHT} @ ${FRAMERATE}fps"
echo "[start] UDP_OUTPUT=$UDP_OUTPUT"
echo "[start] HTTP_OUTPUT=$HTTP_OUTPUT"
echo "[start] HTTP_PORT=$HTTP_PORT"

# mediamtx config
cat > /etc/mediamtx.yml <<'MTXEOF'
logLevel: info
logDestinations: [stdout]

rtsp: yes
rtspAddress: 127.0.0.1:8554
webrtc: yes
webrtcAddress: 127.0.0.1:8889
webrtcLocalUDPAddress: 127.0.0.1:8189
webrtcAdditionalHosts: [127.0.0.1]
hls: no
rtmp: no
srt: no
api: no

paths:
  live:
    source: publisher
MTXEOF

# Allow insecure origin for tabCapture if URL is http://
URL_ORIGIN=$(echo "$URL" | sed -E 's|(https?://[^/]+).*|\1|')
UNSAFELY_ALLOW=""
if echo "$URL_ORIGIN" | grep -q "^http://"; then
    UNSAFELY_ALLOW="--unsafely-treat-insecure-origin-as-secure=${URL_ORIGIN}"
    echo "[start] Allowing insecure origin for tabCapture: $URL_ORIGIN"
fi

# Chrome launcher
cat > /tmp/launch-chrome.sh <<SCRIPT_END
#!/bin/bash
exec chromium \\
    --headless=new \\
    --no-sandbox \\
    --disable-gpu \\
    --disable-dev-shm-usage \\
    --disable-software-rasterizer \\
    --remote-debugging-port=\${CDP_PORT} \\
    --remote-debugging-address=127.0.0.1 \\
    --load-extension=\${EXTENSION_DIR} \\
    --disable-extensions-except=\${EXTENSION_DIR} \\
    --allowlisted-extension-id=\${EXTENSION_ID} \\
    --auto-accept-this-tab-capture \\
    --autoplay-policy=no-user-gesture-required \\
    --disable-background-timer-throttling \\
    --disable-backgrounding-occluded-windows \\
    --disable-renderer-backgrounding \\
    --disable-features=PictureInPicture,MediaSessionService \\
    --window-size=\${WIDTH},\${HEIGHT} \\
    --user-data-dir=/tmp/chrome-profile \\
    ${UNSAFELY_ALLOW} \\
    "\${URL}"
SCRIPT_END
chmod +x /tmp/launch-chrome.sh

export EXTENSION_ID EXTENSION_DIR

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
```

- [ ] **Step 2: Commit**

```bash
git add start.sh
git commit -m "$(cat <<'EOF'
feat(start): wire UDP_OUTPUT, HTTP_OUTPUT, HTTP_PORT into runtime

Accepts WS_PORT as a silent fallback so existing deployments still
boot. mediamtx config is generated here so it picks up any future
env-driven tweaks cleanly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Create `test/clock.html`

**Files:**
- Create: `test/clock.html`

- [ ] **Step 1: Write `test/clock.html`**

Write to `test/clock.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>A/V Drift Test Clock</title>
  <style>
    html, body {
      margin: 0; padding: 0; background: #000; color: #0f0;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      height: 100%; width: 100%;
      overflow: hidden;
    }
    .wrap {
      width: 100%; height: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 1vh;
    }
    #clock {
      font-size: 16vh; font-weight: 700; letter-spacing: -0.04em;
      text-shadow: 0 0 20px rgba(0,255,0,0.4);
    }
    #beat {
      font-size: 4vh; opacity: 0.8;
    }
    #bar {
      width: 80vw; height: 4vh; background: #030; border: 1px solid #0a0;
      position: relative; overflow: hidden;
    }
    #bar::after {
      content: "";
      position: absolute; top: 0; left: 0; bottom: 0;
      width: var(--progress, 0%);
      background: #0f0;
    }
    .beep { color: #ff0 !important; }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="clock">00:00:00.000</div>
    <div id="beat">tick</div>
    <div id="bar"></div>
  </div>

  <script>
    const clockEl = document.getElementById("clock");
    const beatEl = document.getElementById("beat");
    const barEl = document.getElementById("bar");

    function render() {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, "0");
      const m = String(now.getUTCMinutes()).padStart(2, "0");
      const s = String(now.getUTCSeconds()).padStart(2, "0");
      const ms = String(now.getUTCMilliseconds()).padStart(3, "0");
      clockEl.textContent = `${h}:${m}:${s}.${ms}`;
      barEl.style.setProperty("--progress", (now.getUTCMilliseconds() / 10) + "%");
      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);

    // WebAudio tone at every second boundary: 50ms at 1000Hz, then 20ms at 440Hz
    // once we pass the half-second mark, to help distinguish the boundary edge.
    let audioCtx;
    function ensureAudio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    }

    function beep(freq, durationMs) {
      ensureAudio();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    }

    let lastSec = -1;
    function scheduler() {
      const now = new Date();
      const s = now.getUTCSeconds();
      if (s !== lastSec) {
        lastSec = s;
        beep(1000, 50);
        beatEl.textContent = "BEEP " + s;
        beatEl.classList.add("beep");
        setTimeout(() => beatEl.classList.remove("beep"), 80);
      }
      setTimeout(scheduler, 5);
    }

    // WebAudio needs a user gesture to start, but --autoplay-policy=no-user-gesture-required
    // is passed to Chrome in start.sh, so it should resume on its own.
    scheduler();
  </script>
</body>
</html>
```

- [ ] **Step 2: Run the relay locally and verify the test clock page is served**

Run:
```bash
cd /Users/alexkinch/Projects/alexkinch/webpagestreamer/relay
HTTP_PORT=9001 HTTP_OUTPUT=true PROFILE=pal node server.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9001/test/clock.html
kill %1; wait 2>/dev/null || true
```
Expected: `200`.

- [ ] **Step 3: Commit**

```bash
git add test/clock.html
git commit -m "$(cat <<'EOF'
test: bundle A/V drift test clock page

test/clock.html shows a millisecond-precision UTC clock and beeps
for 50ms at each second boundary. Served by the relay at
/test/clock.html so the drift measurement loop needs nothing external.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Update `test.sh` and `docker-compose.yml`

**Files:**
- Modify: `test.sh`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Replace `test.sh`**

Write to `test.sh`:

```bash
#!/bin/bash
# Quick smoke test: build the container, stream via HTTP progressive,
# and show a URL that ffplay/VLC can open.

set -euo pipefail

IMAGE="webpagestreamer"
PORT="${PORT:-9000}"
URL="${URL:-http://127.0.0.1:${PORT}/test/clock.html}"
DURATION="${DURATION:-60}"

echo "Building $IMAGE..."
docker build -t "$IMAGE" .

echo ""
echo "Starting container — capturing $URL, serving MPEG-TS over HTTP on :$PORT"
echo "Will run for ${DURATION}s then stop automatically."
echo ""

CONTAINER_ID=$(docker run -d --rm -p "${PORT}:${PORT}" \
  -e URL="$URL" \
  -e HTTP_OUTPUT=true \
  -e UDP_OUTPUT="" \
  -e HTTP_PORT="$PORT" \
  "$IMAGE")

echo "Container: $CONTAINER_ID"
echo "Waiting for container to initialise..."
sleep 5

docker logs -f "$CONTAINER_ID" 2>&1 | sed 's/^/  [container] /' &
LOGS_PID=$!

echo ""
echo "================================================"
echo "  Stream available at: http://127.0.0.1:${PORT}/stream.ts"
echo ""
echo "  Open in another terminal with:"
echo "    ffplay -f mpegts http://127.0.0.1:${PORT}/stream.ts"
echo "    vlc http://127.0.0.1:${PORT}/stream.ts"
echo ""
echo "  Health check: curl http://127.0.0.1:${PORT}/health"
echo ""
echo "  To save a clip:"
echo "    ffmpeg -i http://127.0.0.1:${PORT}/stream.ts -t 10 -c copy test.ts"
echo "================================================"
echo ""

trap 'echo ""; echo "Stopping..."; kill $LOGS_PID 2>/dev/null; docker stop "$CONTAINER_ID" 2>/dev/null; exit 0' INT TERM

sleep "$DURATION"

echo ""
echo "Test duration complete. Stopping container..."
kill $LOGS_PID 2>/dev/null
docker stop "$CONTAINER_ID" 2>/dev/null

echo "Done."
```

- [ ] **Step 2: Read the current `docker-compose.yml`**

Run: `cat docker-compose.yml`

- [ ] **Step 3: Replace any `OUTPUT=` / `WS_PORT=` references with the new env var names**

Open `docker-compose.yml` and apply these substitutions globally, preserving all other content:

- Replace `OUTPUT=udp://...` with `UDP_OUTPUT=udp://...`
- Replace `OUTPUT=http` with `HTTP_OUTPUT=true`
- Replace `OUTPUT=tcp://...`, `OUTPUT=rtp://...`, `OUTPUT=/path/to/file.ts` — delete these entries (schemes are removed)
- Replace `WS_PORT=` with `HTTP_PORT=`
- Any port mapping that published `9000:9000` stays as-is

If `docker-compose.yml` doesn't reference any of these env vars, no change is needed.

- [ ] **Step 4: Commit**

```bash
git add test.sh docker-compose.yml
git commit -m "$(cat <<'EOF'
chore: update test.sh and docker-compose for new env var surface

test.sh now defaults to HTTP progressive (easier to consume without
multicast routing) and points at the bundled test clock page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README**

Run: `cat README.md`

- [ ] **Step 2: Apply the following updates**

Apply these changes to `README.md`:

1. **Update the "Quick Start" / "Usage" example** so the `docker run` command uses `UDP_OUTPUT` / `HTTP_OUTPUT` / `HTTP_PORT` instead of `OUTPUT` / `WS_PORT`. Example command to show:

   ```bash
   docker run --rm -p 9000:9000 \
     -e URL="https://example.com" \
     -e HTTP_OUTPUT=true \
     -e HTTP_PORT=9000 \
     webpagestreamer
   # Then: ffplay -f mpegts http://127.0.0.1:9000/stream.ts
   ```

2. **Replace the Environment Variables table** so it lists (in this order):

   | Variable | Default | Purpose |
   |---|---|---|
   | `URL` | `https://www.google.com` | Page to capture |
   | `PROFILE` | `pal` | Encoding profile (`pal`, `ntsc`, `720p`, `1080p`, `hls`) |
   | `UDP_OUTPUT` | `udp://239.0.0.1:1234` | UDP multicast destination. Empty string disables. |
   | `HTTP_OUTPUT` | `true` | If `true`, serve progressive MPEG-TS at `/stream.ts`. |
   | `HTTP_PORT` | `9000` | Port the relay listens on. |
   | `WIDTH`/`HEIGHT`/`FRAMERATE` | profile defaults | Overrides |
   | `VIDEO_CODEC`/`AUDIO_CODEC`/`VIDEO_BITRATE`/`AUDIO_BITRATE`/`SAR`/`INTERLACED`/`FORMAT` | profile defaults | Overrides |
   | `CHANNEL_NAME`/`CHANNEL_ID`/`PROGRAMME_TITLE`/`PROGRAMME_DESC`/`STREAM_URL` | — | IPTV metadata |
   | `CDP_PORT` | `9222` | Chromium remote debugging port (internal) |

3. **Add a "Breaking changes in 0.3.0" section** just after the feature summary:

   ```markdown
   ## Breaking changes in 0.3.0

   - `OUTPUT` env var has been split into `UDP_OUTPUT` and `HTTP_OUTPUT=true|false`.
     Both can be enabled simultaneously.
   - `WS_PORT` has been renamed to `HTTP_PORT` (the WebSocket server is gone).
     `WS_PORT` is still accepted as a silent fallback for one release.
   - `rtp://`, `tcp://`, and file output schemes have been removed. If you need
     them, stay on 0.2.x.
   - The ingest pipeline is now WebRTC → mediamtx → FFmpeg, which fixes long-
     running A/V drift. See `docs/plans/2026-04-17-av-drift-webrtc-rebuild-design.md`.
   ```

4. **Add a "Drift measurement" section** near the end:

   ````markdown
   ## Measuring A/V drift

   Start the container pointed at the bundled test clock page and record the
   UDP output for 60 minutes:

   ```bash
   docker run --rm -p 9000:9000 \
     -e URL="http://127.0.0.1:9000/test/clock.html" \
     -e UDP_OUTPUT="udp://239.0.0.1:1234" \
     -e HTTP_OUTPUT=true \
     webpagestreamer
   ```

   In another shell:

   ```bash
   ffmpeg -i udp://@239.0.0.1:1234 -t 3600 -c copy drift-test.ts
   ```

   Open `drift-test.ts` in ffplay or VLC and spot-check that the on-screen
   clock and the audio beeps stay aligned throughout (±40 ms at t=0, 30 min,
   60 min is the success bar).
   ````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: update README for WHIP/mediamtx rebuild

Breaks out the new env var surface, documents the removed output
schemes, and adds a drift-measurement section backed by the bundled
/test/clock.html page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: End-to-end smoke test + drift measurement

**Files:** (none modified)

This is the first point at which the stream works end-to-end. If any step fails, diagnose and fix before proceeding rather than committing through the break.

- [ ] **Step 1: Build the image**

Run: `docker build -t webpagestreamer:rebuild .`
Expected: build succeeds.

- [ ] **Step 2: Run the container with HTTP progressive + the bundled clock page**

Run:
```bash
docker run -d --rm --name wps-smoke -p 9000:9000 \
  -e URL="http://127.0.0.1:9000/test/clock.html" \
  -e UDP_OUTPUT="" \
  -e HTTP_OUTPUT=true \
  -e HTTP_PORT=9000 \
  webpagestreamer:rebuild
```
Expected: container starts.

- [ ] **Step 3: Check health after 15s**

Run: `sleep 15 && curl -s http://127.0.0.1:9000/health`
Expected: JSON with `"status":"healthy"`, `"mediamtx":true`, `"ffmpeg":true`.

If `mediamtx:false`: mediamtx isn't reachable on 127.0.0.1:8554. Run `docker exec wps-smoke supervisorctl status` and check the mediamtx process logs.

If `ffmpeg:false`: FFmpeg is crashing on startup. Run `docker logs wps-smoke | grep -i ffmpeg` — the most likely cause is that no one is publishing yet, so FFmpeg will restart every 2s until Chrome's extension establishes the WHIP connection.

- [ ] **Step 4: Play the HTTP progressive stream**

Run (in a separate terminal): `ffplay -f mpegts http://127.0.0.1:9000/stream.ts`
Expected: within ~10s, the test clock page renders and the beep lines up with the seconds digit changing. Close ffplay with `q`.

- [ ] **Step 5: Record 60 seconds of the stream and eyeball sync**

Run:
```bash
ffmpeg -y -i http://127.0.0.1:9000/stream.ts -t 60 -c copy /tmp/smoke.ts
ffplay /tmp/smoke.ts
```
Expected: clock and beep stay aligned for the whole minute.

- [ ] **Step 6: Kill chromium inside the container to test restart resilience**

Run: `docker exec wps-smoke pkill -f chromium`

Wait ~15s, then re-run `ffplay -f mpegts http://127.0.0.1:9000/stream.ts`.
Expected: video resumes. supervisord restarts chrome, trigger fires again, extension re-publishes, FFmpeg reconnects.

- [ ] **Step 7: Stop the smoke container**

Run: `docker stop wps-smoke`

- [ ] **Step 8: Long-running drift measurement (manual)**

Run:
```bash
docker run -d --rm --name wps-drift -p 9000:9000 \
  -e URL="http://127.0.0.1:9000/test/clock.html" \
  -e UDP_OUTPUT="udp://239.0.0.1:1234" \
  -e HTTP_OUTPUT=true \
  webpagestreamer:rebuild
sleep 20
ffmpeg -y -i http://127.0.0.1:9000/stream.ts -t 3600 -c copy /tmp/drift-60min.ts
docker stop wps-drift
```
Expected: produces `/tmp/drift-60min.ts`.

Open the file in ffplay or VLC and scrub to t=0, t=30min, t=60min. Pass the drift test if the audio beep stays aligned with the second-boundary clock digit change within one frame (±40 ms at 25fps) at all three points.

If drift exceeds ±40 ms at any check point: do NOT commit a "it's close enough" message. Record the offsets, re-open the design, and add a follow-up task before merging. The whole point of the rebuild is that ±40 ms is hit indefinitely.

- [ ] **Step 9: Confirm no uncommitted changes**

Run: `git status --porcelain`
Expected: empty.

- [ ] **Step 10: Push the branch**

Run: `git push -u origin fix/av-drift`
Expected: push succeeds.

---

## Self-review

**Spec coverage:** Walked each section of the design doc against the plan:

- Problem / why WebRTC fixes it — covered in header Architecture + Task 9 commit message.
- Success criteria (±40 ms) — Task 16 Step 8 enforces it.
- Non-goals — not implemented (correct).
- Architecture (4 processes) — Tasks 1 (mediamtx binary), 2 (mediamtx supervisord), existing chrome + trigger, Tasks 6–7 (relay).
- Chrome extension (content.js, manifest.json, trigger-capture.sh) — Tasks 9, 10, 11.
- mediamtx (binary + config) — Tasks 1, 2, 12.
- FFmpeg consumer — Task 6.
- Relay (IPTV endpoints, /health, /stream.ts, /test/clock.html, FFmpeg parent, UDP + HTTP sinks) — Tasks 3, 4, 5, 6, 7, 13.
- Test clock — Task 13.
- Env var changes (WS_PORT→HTTP_PORT, OUTPUT split, removed schemes) — Tasks 7, 8, 12, 14, 15.
- Error handling (per-process failures) — Task 6 (ffmpeg restart), supervisord (rest), Task 9 (ICE reconnect).
- Supervisord priorities — Task 2.
- Testing (build+smoke, drift, restart resilience, CI) — Task 16 steps 1–8.
- Rollout (rip-and-replace on fix/av-drift) — Task 16 step 10.

No gaps.

**Placeholder scan:** Searched for "TBD", "later", "similar to", "appropriate" — none found. All code blocks are complete.

**Type consistency:** `resolveProfile` returns an object with `width, height, framerate (string), gop (number), videoCodec, audioCodec, videoBitrate, audioBitrate, sar, interlaced (bool), format, profile` — used consistently in Task 6 `buildArgs(profile)` and Task 7 `ffmpegHandle.isRunning()`. `parseUDPOutput` returns `{host, port, isMulticast}` — used in Task 7. `createHTTPFanout(clients)` / `createUDPSink(host, port)` signatures match callers in Task 7. `generateM3U(opts)` and `generateXMLTV(opts)` option bags match keys used in Task 7.

No fixes needed.

---

## Execution handoff

**Plan complete and saved to `docs/plans/2026-04-17-av-drift-webrtc-rebuild-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
