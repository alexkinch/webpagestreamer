# Raw-frame ingest implementation plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Implement task-by-task; commit at the end of every task.

**Goal:** Replace the WebRTC → mediamtx → RTSP ingest path with raw `VideoFrame` (I420) + `AudioData` (s16le PCM) captured via `MediaStreamTrackProcessor`, streamed over WebSocket to the relay, and fed directly into ffmpeg as two raw inputs. Eliminates browser-side rate adaptation entirely — broadcast-quality source frames into ffmpeg.

**Architecture:**

```
Chromium tab
  └── extension/content.js
        ├── chrome.tabCapture → MediaStream (audio + video tracks)
        ├── MediaStreamTrackProcessor(video) → VideoFrame stream  ─┐
        └── MediaStreamTrackProcessor(audio) → AudioData stream  ──┤
                                                                   │
                              two WebSocket connections (binary)   │
                                                                   ▼
relay/server.js
  ├── WS  /ingest/video  → write each I420 frame to /tmp/video.fifo
  ├── WS  /ingest/audio  → write each f32le chunk to /tmp/audio.fifo
  └── ffmpeg
        -f rawvideo -pix_fmt yuv420p -s WxH -framerate FR -i /tmp/video.fifo
        -f f32le    -ar 44100 -ac 2                       -i /tmp/audio.fifo
        ... encode → MPEG-TS → HTTP /stream.ts and/or UDP multicast
```

**Spike-confirmed values (Task 1 already run, 2026-04-28):**
- `MediaStreamTrackProcessor` is available in headless Chromium 138 with no flag.
- `VideoFrame.format === "I420"` for tabCapture-sourced video (`coded=720x576` for PAL profile).
- `AudioData.format === "f32-planar"`, `sampleRate === 44100`, `numberOfChannels === 2` for tabCapture-sourced audio. We convert to interleaved f32 via `copyTo({format: "f32"})` for ffmpeg's `-f f32le`.
- Encoder still outputs 48 kHz audio (`-ar 48000` on the output side); ffmpeg resamples 44100 → 48000 internally.

**Why this fixes both drift and quality:**
- Each `VideoFrame` and `AudioData` carries its own source-clock timestamp, but ffmpeg re-clocks both inputs deterministically via `-framerate` / `-ar`. Because both raw streams come from the same browser process and are fed unbuffered, A/V stays locked.
- No browser-side encoder, no congestion-controlled bitrate, no transport codec. ffmpeg sees raw I420 — quality is bounded only by ffmpeg's encode settings, not the wire.

**Tech stack:** Chromium (headless) + WebCodecs / MediaStreamTrackProcessor in the extension; Node `ws` + `node:net` + `mkfifo` in the relay; ffmpeg unchanged.

**Branch decision (decide before starting):**
- **Option A** — continue on `fix/av-drift` and force-push (rewrites PR #20). Pro: keeps a single PR. Con: PR history will be confusing — the description still says "WebRTC/WHIP".
- **Option B** — new branch `feat/raw-frame-ingest` off `main`, close PR #20 unmerged. Cleanest history; recommended.

The plan below assumes Option B. If Option A is chosen, skip Task 0 and rebase work onto `fix/av-drift` instead.

---

## File structure

| File | Change |
|---|---|
| `extension/content.js` | **Rewrite.** Drop WebRTC/WHIP code. Use `MediaStreamTrackProcessor` + two `WebSocket`s. |
| `extension/manifest.json` | Drop `http://127.0.0.1:8889/*` host permission; add `ws://127.0.0.1:9000/*` if needed. |
| `relay/ingest.js` | **New.** WebSocket server for `/ingest/video` and `/ingest/audio`; pipes WS messages to fifos. |
| `relay/ffmpeg.js` | Replace RTSP input with two `-i fifo` inputs; create fifos before spawning ffmpeg. |
| `relay/server.js` | Mount the WS upgrade handler from `relay/ingest.js`; drop mediamtx reachability check from `/health`. |
| `relay/package.json` | Add `ws` dep (we previously dropped it — re-add for ingest). |
| `relay/test/ingest.test.js` | **New.** Round-trip test: WS in → fifo out. |
| `Dockerfile` | Drop mediamtx download stage; drop `py3-websockets` if trigger no longer needs CDP WS (it does — keep). |
| `supervisord.conf` | Drop `[program:mediamtx]`. |
| `start.sh` | Drop mediamtx config generation; drop port 8554 wait in chrome launcher; keep relay HTTP wait. |
| `trigger-capture.sh` | Drop `WHIP_URL` from `CAPTURE_COMMAND`. |
| `README.md` | Update architecture diagram and "How it works" section. |
| `docs/plans/2026-04-28-raw-frame-ingest-plan.md` | This document. |

`extension/background.js` is unchanged — it only mints stream IDs.

---

## Task 0 — Branch + worktree setup

**Files:** none (git operations).

- [ ] **Step 1:** Create branch off latest main.

```bash
git fetch origin
git checkout -b feat/raw-frame-ingest origin/main
```

- [ ] **Step 2:** Cherry-pick the test-clock asset and the trigger-capture re-fire fix from `fix/av-drift` (still useful regardless of ingest path).

```bash
git log --oneline fix/av-drift -- test/clock.html trigger-capture.sh
# Pick the commits that add test/clock.html, the relay extraction, and the
# trigger re-fire. Skip commits that touch WHIP/mediamtx.
```

If conflict noise is high, just copy the files over manually and commit. The point is: keep the test clock and the trigger robustness; drop everything WebRTC.

- [ ] **Step 3:** Commit and push branch.

```bash
git push -u origin feat/raw-frame-ingest
```

---

## Task 1 — Spike: confirm `MediaStreamTrackProcessor` works in headless Chromium and produces I420 ✅ done

**Outcome (2026-04-28):** Verified by running on `feat/raw-frame-ingest` (image built from main + spike probe). Logs from chromium showed:

```
[spike] MediaStreamTrackProcessor = function
[spike] VIDEO format=I420 coded=720x576 ts=441168537815
[spike] AUDIO format=f32-planar sr=44100 ch=2 frames=441
```

Conclusions baked into the plan:
- I420 video, no flag needed.
- f32-planar audio at **44.1 kHz**, not 48 kHz. Plan updated to ship f32le interleaved over the wire and let ffmpeg resample on the encoder side.

The original spike instructions are kept below for reference only.

**Goal:** Before rewriting anything, prove that headless Chromium 138 (Alpine 3.21 default) exposes `MediaStreamTrackProcessor` against a `tabCapture` stream and that `VideoFrame.format` is `I420`. If it isn't, we need a `--enable-blink-features` flag or a format conversion path, and the rest of the plan changes.

**Files:** scratch only — discard after.

- [ ] **Step 1:** In a running container, paste this into the extension's content script via the existing CDP trigger (or evaluate via `chrome://inspect`):

```js
const { streamId } = await new Promise((r) =>
  chrome.runtime.sendMessage({ command: "get-stream-id" }, r)
);
const s = await navigator.mediaDevices.getUserMedia({
  audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
});
const vt = s.getVideoTracks()[0];
const at = s.getAudioTracks()[0];
const vp = new MediaStreamTrackProcessor({ track: vt });
const ap = new MediaStreamTrackProcessor({ track: at });
const vr = vp.readable.getReader();
const ar = ap.readable.getReader();
const v = await vr.read();
const a = await ar.read();
console.log("VIDEO", v.value.format, v.value.codedWidth, "x", v.value.codedHeight, "ts=", v.value.timestamp);
console.log("AUDIO", a.value.format, a.value.sampleRate, "Hz x", a.value.numberOfChannels, "ch frames=", a.value.numberOfFrames);
v.value.close(); a.value.close();
```

Expected: `VIDEO I420 720 x 576 ts=<n>` and `AUDIO f32-planar 48000 Hz x 2 ch frames=480` (or similar).

- [ ] **Step 2:** Record the actual output in a comment on the PR. If `format !== "I420"`, add a follow-up task to either request the format via constraints or convert. If `MediaStreamTrackProcessor` is `undefined`, add `--enable-blink-features=MediaStreamInsertableStreams` to the chromium launch in `start.sh` and retry.

- [ ] **Step 3:** No commit — this is throwaway. Move on once the format is confirmed.

---

## Task 2 — Wire protocol contract (no code, just decision)

Document the exact message format both sides agree on. The next two tasks implement against this.

**Decision:**

- **Two WebSocket connections.** Each carries one media type. Backpressure on video doesn't stall audio.
- **One WS message = one media unit.** No framing inside the message — WS already frames binary messages.
- **Video** message body = raw I420 frame bytes, planes concatenated in order Y, U, V. Length = `width * height * 3 / 2`.
- **Audio** message body = raw `f32le` interleaved stereo, **44.1 kHz** (browser default; encoder resamples to 48 kHz). Length = `numberOfFrames × 2 channels × 4 bytes`.
- **Connection negotiation:** the extension connects once at startup with query params: `/ingest/video?w=720&h=576&fr=25` and `/ingest/audio?sr=44100&ch=2`. The relay validates and refuses anything else. No per-frame headers.
- **Reconnect:** if either WS closes, the extension waits 2 s and reconnects. Simple, idempotent.

Add this as a code comment at the top of `relay/ingest.js` and `extension/content.js` so the next reader doesn't have to grep for it.

---

## Task 3 — Add `ws` dep + scaffold `relay/ingest.js`

**Files:**
- Modify: `relay/package.json`
- Create: `relay/ingest.js`
- Create: `relay/test/ingest.test.js`

- [ ] **Step 1:** Re-add `ws`.

```bash
cd relay && npm install ws@^8
cd ..
```

Verify `relay/package.json` has `"ws": "^8.x.x"` under dependencies, and `relay/package-lock.json` is updated.

- [ ] **Step 2:** Write the failing test. Two clients connect, send N messages each, the server writes them to two `Writable` sinks supplied by the caller.

`relay/test/ingest.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { Writable } = require("node:stream");
const WebSocket = require("ws");
const { mountIngest } = require("../ingest.js");

function collector() {
  const chunks = [];
  return {
    sink: new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }),
    chunks,
  };
}

test("video and audio WS messages are forwarded to their sinks in order", async () => {
  const v = collector();
  const a = collector();

  const httpServer = http.createServer();
  mountIngest(httpServer, { videoSink: v.sink, audioSink: a.sink, expected: { width: 4, height: 4, framerate: 25, sampleRate: 44100, channels: 2 } });
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;

  const vws = new WebSocket(`ws://127.0.0.1:${port}/ingest/video?w=4&h=4&fr=25`);
  const aws = new WebSocket(`ws://127.0.0.1:${port}/ingest/audio?sr=44100&ch=2`);
  await Promise.all([
    new Promise((r) => vws.once("open", r)),
    new Promise((r) => aws.once("open", r)),
  ]);

  vws.send(Buffer.from([1, 2, 3]));
  vws.send(Buffer.from([4, 5, 6]));
  aws.send(Buffer.from([7, 8]));
  aws.send(Buffer.from([9, 10]));

  // Give the server a tick to flush.
  await new Promise((r) => setTimeout(r, 50));

  assert.deepStrictEqual(Buffer.concat(v.chunks), Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.deepStrictEqual(Buffer.concat(a.chunks), Buffer.from([7, 8, 9, 10]));

  vws.close(); aws.close();
  await new Promise((r) => httpServer.close(r));
});

test("video WS connection is rejected on dimension mismatch", async () => {
  const v = collector();
  const a = collector();
  const httpServer = http.createServer();
  mountIngest(httpServer, { videoSink: v.sink, audioSink: a.sink, expected: { width: 720, height: 576, framerate: 25, sampleRate: 48000, channels: 2 } });
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;

  const vws = new WebSocket(`ws://127.0.0.1:${port}/ingest/video?w=1280&h=720&fr=25`);
  // Server should reject the upgrade with HTTP 400 — ws emits 'unexpected-response'.
  await new Promise((r) => vws.once("unexpected-response", () => { vws.terminate(); r(); }));

  await new Promise((r) => httpServer.close(r));
});
```

- [ ] **Step 3:** Run, confirm it fails.

```bash
cd relay && node --test test/ingest.test.js
```

Expected: cannot find module `../ingest.js`.

- [ ] **Step 4:** Implement `relay/ingest.js`.

```js
// Wire protocol:
//   ws://host:PORT/ingest/video?w=<W>&h=<H>&fr=<FR>
//     each binary message = one raw I420 frame (W*H*3/2 bytes), planes Y U V
//   ws://host:PORT/ingest/audio?sr=<SR>&ch=<CH>
//     each binary message = raw s16le interleaved PCM, variable length
//
// Both connections must validate against `expected` (set by the relay from
// the resolved profile); mismatched params are rejected at handshake.

const { WebSocketServer } = require("ws");
const url = require("node:url");

function mountIngest(httpServer, { videoSink, audioSink, expected }) {
  const wssVideo = new WebSocketServer({ noServer: true });
  const wssAudio = new WebSocketServer({ noServer: true });

  wssVideo.on("connection", (ws) => {
    console.log("[ingest] video client connected");
    ws.on("message", (data) => videoSink.write(data));
    ws.on("close", () => console.log("[ingest] video client disconnected"));
    ws.on("error", (e) => console.warn("[ingest] video error:", e.message));
  });

  wssAudio.on("connection", (ws) => {
    console.log("[ingest] audio client connected");
    ws.on("message", (data) => audioSink.write(data));
    ws.on("close", () => console.log("[ingest] audio client disconnected"));
    ws.on("error", (e) => console.warn("[ingest] audio error:", e.message));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname === "/ingest/video") {
      const w = parseInt(query.w, 10);
      const h = parseInt(query.h, 10);
      const fr = parseFloat(query.fr);
      if (w !== expected.width || h !== expected.height || fr !== expected.framerate) {
        console.warn(`[ingest] rejecting video upgrade: got ${w}x${h}@${fr} expected ${expected.width}x${expected.height}@${expected.framerate}`);
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy();
        return;
      }
      wssVideo.handleUpgrade(req, socket, head, (ws) => wssVideo.emit("connection", ws, req));
      return;
    }
    if (pathname === "/ingest/audio") {
      const sr = parseInt(query.sr, 10);
      const ch = parseInt(query.ch, 10);
      if (sr !== expected.sampleRate || ch !== expected.channels) {
        console.warn(`[ingest] rejecting audio upgrade: got ${sr}Hz×${ch} expected ${expected.sampleRate}Hz×${expected.channels}`);
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy();
        return;
      }
      wssAudio.handleUpgrade(req, socket, head, (ws) => wssAudio.emit("connection", ws, req));
      return;
    }
    // Other upgrades are not ours — let the default handler 404 by destroying.
    socket.destroy();
  });
}

module.exports = { mountIngest };
```

- [ ] **Step 5:** Re-run tests; expect PASS.

```bash
cd relay && node --test test/ingest.test.js
```

- [ ] **Step 6:** Commit.

```bash
git add relay/ingest.js relay/test/ingest.test.js relay/package.json relay/package-lock.json
git commit -m "feat(relay): WS ingest endpoints for raw video + audio frames"
```

---

## Task 4 — Switch ffmpeg input to two named pipes

**Files:**
- Modify: `relay/ffmpeg.js`
- Modify: `relay/test/` (add an args test if one exists; otherwise skip)

- [ ] **Step 1:** Replace the input args. Show the full new `buildArgs`.

```js
const VIDEO_FIFO = "/tmp/video.fifo";
const AUDIO_FIFO = "/tmp/audio.fifo";

function buildArgs(profile) {
  const args = [
    "-fflags", "+genpts",

    // Raw I420 video pipe — ffmpeg paces by -framerate.
    "-f", "rawvideo",
    "-pix_fmt", "yuv420p",
    "-s", `${profile.width}x${profile.height}`,
    "-framerate", profile.framerate,
    "-thread_queue_size", "1024",
    "-i", VIDEO_FIFO,

    // Raw f32le audio pipe at 44.1 kHz (browser default). The encoder's
    // -ar 48000 below makes ffmpeg resample on the fly.
    "-f", "f32le",
    "-ar", "44100",
    "-ac", "2",
    "-thread_queue_size", "1024",
    "-i", AUDIO_FIFO,

    "-c:v", profile.videoCodec,
    "-b:v", profile.videoBitrate,
    "-maxrate", profile.videoBitrate,
    "-bufsize", "2000k",
    "-pix_fmt", "yuv420p",
    "-g", String(profile.gop),
    "-bf", "2",
  ];

  if (profile.interlaced) args.push("-flags", "+ilme+ildct");
  if (profile.videoCodec === "libx264") args.push("-preset", "veryfast", "-tune", "zerolatency");

  args.push("-vf", `setsar=${profile.sar}`);
  // Output audio at 48 kHz regardless of input rate — ffmpeg resamples
  // 44100 → 48000 via swresample.
  args.push("-c:a", profile.audioCodec, "-b:a", profile.audioBitrate, "-ar", "48000", "-ac", "2");
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
```

Note: `-s` and `-ac`/`-ar` go **before** `-i` for raw inputs (they describe the input format). The encoder block stays after the `-i`s.

- [ ] **Step 2:** Add a `setupPipes()` helper that creates the fifos before spawning ffmpeg.

```js
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function setupPipes() {
  for (const fifo of [VIDEO_FIFO, AUDIO_FIFO]) {
    try { fs.unlinkSync(fifo); } catch {}
    execFileSync("mkfifo", [fifo]);
  }
}
```

- [ ] **Step 3:** Call `setupPipes()` before the first `spawnOnce()` and export the fifo paths so `server.js` can `fs.createWriteStream` them.

```js
function startFFmpeg({ profile, onData, restartDelayMs = 2000 }) {
  setupPipes();
  let current = null;
  // ... unchanged spawnOnce()
}

module.exports = { startFFmpeg, buildArgs, VIDEO_FIFO, AUDIO_FIFO, HLS_DIR };
```

- [ ] **Step 4:** Manual test — run `node -e "require('./relay/ffmpeg.js')"` in the container, confirm `/tmp/video.fifo` and `/tmp/audio.fifo` are created. (Won't work outside container; verify in Task 8 smoke test.)

- [ ] **Step 5:** Commit.

```bash
git add relay/ffmpeg.js
git commit -m "feat(relay): ffmpeg reads raw I420 + s16le from two fifos"
```

---

## Task 5 — Wire ingest into the relay; drop mediamtx checks

**Files:**
- Modify: `relay/server.js`

- [ ] **Step 1:** Open the fifos for writing once ffmpeg has been spawned (ffmpeg holds the read end), and pass those streams as sinks to `mountIngest`.

```js
const { mountIngest } = require("./ingest.js");
const { startFFmpeg, VIDEO_FIFO, AUDIO_FIFO, HLS_DIR } = require("./ffmpeg.js");

const ffmpegHandle = startFFmpeg({
  profile,
  onData: (chunk) => { for (const sink of sinks) sink.write(chunk); },
});

// Open fifo writers AFTER ffmpeg has opened them for reading. Otherwise
// open() blocks. ffmpeg opens both fifos during its input-probing step,
// which happens immediately on spawn, so a small delay is enough.
const videoSink = fs.createWriteStream(VIDEO_FIFO);
const audioSink = fs.createWriteStream(AUDIO_FIFO);

mountIngest(server, {
  videoSink,
  audioSink,
  expected: {
    width: profile.width,
    height: profile.height,
    framerate: parseFloat(profile.framerate),
    sampleRate: 44100,
    channels: 2,
  },
});
```

(`server` is the `http.createServer(...)` already in this file. Move the `mountIngest` call after `server` is created.)

- [ ] **Step 2:** Remove the `mediamtxReachable` helper and its use in `/health`. Replace with an "ingest connected" flag.

```js
let videoIngestConnected = false;
let audioIngestConnected = false;
mountIngest(server, {
  videoSink, audioSink,
  onVideoConnect: (b) => { videoIngestConnected = b; },
  onAudioConnect: (b) => { audioIngestConnected = b; },
  expected: { /* ... */ },
});
```

Update `mountIngest` (Task 3 file) to call `onVideoConnect(true)` on `connection` and `onVideoConnect(false)` on `close`, same for audio. Re-run the ingest tests; update them if signatures changed.

Update `/health` body:

```js
const healthy = videoIngestConnected && audioIngestConnected && ffmpegHandle.isRunning();
res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
res.end(JSON.stringify({
  status: healthy ? "healthy" : "unhealthy",
  ingest: { video: videoIngestConnected, audio: audioIngestConnected },
  ffmpeg: ffmpegHandle.isRunning(),
  profile: profile.profile,
  format: profile.format,
  udp_output: UDP_OUTPUT || null,
  http_output: HTTP_OUTPUT,
}));
```

- [ ] **Step 3:** Commit.

```bash
git add relay/server.js relay/ingest.js relay/test/ingest.test.js
git commit -m "feat(relay): pipe WS ingest into ffmpeg fifos; replace mediamtx health probe"
```

---

## Task 6 — Rewrite extension content script

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/manifest.json`

- [ ] **Step 1:** Replace `extension/content.js` with the raw-frame publisher. Full new file:

```js
// Capture flow:
//   chrome.tabCapture → MediaStream
//   MediaStreamTrackProcessor(video) → VideoFrame stream → I420 bytes → WS /ingest/video
//   MediaStreamTrackProcessor(audio) → AudioData stream → s16le bytes → WS /ingest/audio
//
// Wire protocol (per-message, no inner framing):
//   video: width*height*3/2 bytes, planes Y U V concatenated (I420)
//   audio: variable-length f32le interleaved stereo at 44.1 kHz

(function () {
  let stopped = false;

  function hideScrollbars() {
    const style = document.createElement("style");
    style.textContent = `
      html, body { overflow: hidden !important; }
      ::-webkit-scrollbar { display: none !important; }
      video::-webkit-media-controls,
      video::-webkit-media-controls-overlay-play-button,
      video::-webkit-media-controls-enclosure { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function forceFrames() {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:2147483647;";
    document.documentElement.appendChild(el);
    let toggle = false;
    (function tick() {
      toggle = !toggle;
      el.style.opacity = toggle ? "0.01" : "0.02";
      requestAnimationFrame(tick);
    })();
  }

  async function getTabStream(width, height, framerate) {
    const response = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ command: "get-stream-id" }, resolve)
    );
    if (!response || response.error) {
      throw new Error(`get-stream-id failed: ${response && response.error}`);
    }
    const constraints = {
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: response.streamId } },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: response.streamId,
          minFrameRate: framerate, maxFrameRate: framerate,
          minWidth: width, maxWidth: width,
          minHeight: height, maxHeight: height,
        },
      },
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  async function openWS(url) {
    while (!stopped) {
      try {
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", rej, { once: true });
        });
        return ws;
      } catch (e) {
        console.warn(`[capture] WS connect to ${url} failed, retrying in 2s:`, e);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error("stopped");
  }

  function packI420(frame) {
    // Layout: Y plane (W*H), U plane (W/2 * H/2), V plane (W/2 * H/2).
    const W = frame.codedWidth, H = frame.codedHeight;
    const ySize = W * H;
    const uvSize = (W / 2) * (H / 2);
    const buf = new Uint8Array(ySize + 2 * uvSize);
    return frame.copyTo(buf, {
      layout: [
        { offset: 0,                 stride: W },
        { offset: ySize,             stride: W / 2 },
        { offset: ySize + uvSize,    stride: W / 2 },
      ],
    }).then(() => buf.buffer);
  }

  async function pumpVideo(track, ws) {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      try {
        if (ws.bufferedAmount > 8 * 1024 * 1024) {
          // 8 MB backlog: drop this frame to avoid runaway memory if relay stalls.
          console.warn("[capture] WS video backpressure — dropping frame");
        } else {
          const ab = await packI420(frame);
          ws.send(ab);
        }
      } finally {
        frame.close();
      }
    }
  }

  async function pumpAudio(track, ws) {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    while (!stopped) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      try {
        const samples = chunk.numberOfFrames * chunk.numberOfChannels;
        const buf = new Float32Array(samples);
        // Request interleaved f32 — matches what CEF gives OBS, and ffmpeg
        // reads it as -f f32le -ac 2.
        chunk.copyTo(buf, { planeIndex: 0, format: "f32" });
        ws.send(buf.buffer);
      } finally {
        chunk.close();
      }
    }
  }

  async function startCapture({ width, height, framerate, relayHost }) {
    hideScrollbars();
    forceFrames();
    let stream;
    try {
      stream = await getTabStream(width, height, framerate);
    } catch (e) {
      console.error("[capture] tabCapture failed, retrying in 2s:", e);
      setTimeout(() => startCapture({ width, height, framerate, relayHost }), 2000);
      return;
    }

    const vTrack = stream.getVideoTracks()[0];
    const aTrack = stream.getAudioTracks()[0];

    const vURL = `ws://${relayHost}/ingest/video?w=${width}&h=${height}&fr=${framerate}`;
    const aURL = `ws://${relayHost}/ingest/audio?sr=44100&ch=2`;

    const [vWS, aWS] = await Promise.all([openWS(vURL), openWS(aURL)]);
    console.log("[capture] WS connections established; pumping frames");

    pumpVideo(vTrack, vWS).catch((e) => console.error("[capture] video pump:", e));
    pumpAudio(aTrack, aWS).catch((e) => console.error("[capture] audio pump:", e));

    vWS.addEventListener("close", () => { stopped = true; setTimeout(() => location.reload(), 2000); });
    aWS.addEventListener("close", () => { stopped = true; setTimeout(() => location.reload(), 2000); });
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
      const relayHost = event.data.relayHost || "127.0.0.1:9000";
      console.log(`[capture] start — ${width}x${height}@${framerate}fps → ws://${relayHost}/ingest/*`);
      startCapture({ width, height, framerate, relayHost });
    }
  });
})();
```

Notes on the design:
- We page-reload on socket close, which forces a full re-handshake via the existing trigger. Crude, robust.
- The 8 MB backpressure cap is a guard against runaway memory if the relay or ffmpeg stalls — at PAL 720×576 that's ~14 frames.

- [ ] **Step 2:** Update `extension/manifest.json`. Drop the WHIP host permission; the content script's `WebSocket` constructor against `ws://127.0.0.1:9000` does not require a host_permission entry under MV3, but we add it for clarity and for any debugging tools.

```json
"host_permissions": [
  "<all_urls>",
  "ws://127.0.0.1:9000/*"
],
```

- [ ] **Step 3:** Commit.

```bash
git add extension/content.js extension/manifest.json
git commit -m "feat(extension): publish raw I420+s16le over WebSocket via MediaStreamTrackProcessor"
```

---

## Task 7 — Update trigger and start scripts; drop mediamtx from supervisord/Dockerfile

**Files:**
- Modify: `trigger-capture.sh`
- Modify: `start.sh`
- Modify: `supervisord.conf`
- Modify: `Dockerfile`

- [ ] **Step 1:** `trigger-capture.sh` — drop `WHIP_URL`, pass `relayHost` instead.

In the `Runtime.evaluate` payload, change:

```python
window.postMessage({
    type: 'CAPTURE_COMMAND',
    command: 'start',
    relayHost: '127.0.0.1:${HTTP_PORT}',
    width: ${WIDTH},
    height: ${HEIGHT},
    framerate: ${FRAMERATE}
}, '*');
```

Remove the `WHIP_URL` env var resolution at the top of the script.

- [ ] **Step 2:** `start.sh` — remove the mediamtx config heredoc (`/etc/mediamtx.yml`) and the port 8554 wait inside `/tmp/launch-chrome.sh`.

The chromium launcher's wait loop becomes:

```bash
echo "[chrome] waiting for relay :${HTTP_PORT}..."
for _ in $(seq 1 60); do
    if (echo > /dev/tcp/127.0.0.1/${HTTP_PORT}) 2>/dev/null; then
        echo "[chrome] relay ready"; break
    fi
    sleep 0.5
done
```

If Task 1's spike showed `MediaStreamTrackProcessor` requires a flag, also add `--enable-blink-features=MediaStreamInsertableStreams` to the chromium launch line.

- [ ] **Step 3:** `supervisord.conf` — delete the `[program:mediamtx]` block.

- [ ] **Step 4:** `Dockerfile` — delete the mediamtx download/extract layer (lines 18–30 in the current file).

- [ ] **Step 5:** Commit.

```bash
git add trigger-capture.sh start.sh supervisord.conf Dockerfile
git commit -m "chore: drop mediamtx — no longer needed with raw-frame ingest"
```

---

## Task 8 — End-to-end smoke test

**Files:** none changed.

- [ ] **Step 1:** Build.

```bash
docker build -t webpagestreamer:raw-frame .
```

- [ ] **Step 2:** Run pointed at the test clock.

```bash
docker run --rm -d --name wps-raw -p 9000:9000 \
  -e URL="http://127.0.0.1:9000/test/clock.html" \
  -e HTTP_OUTPUT=true -e UDP_OUTPUT="" -e HTTP_PORT=9000 \
  webpagestreamer:raw-frame
sleep 15
curl -s http://127.0.0.1:9000/health | jq
```

Expected: `status: "healthy"`, `ingest: { video: true, audio: true }`, `ffmpeg: true`.

- [ ] **Step 3:** Pull 10 s of stream and probe.

```bash
ffprobe -v error -show_streams -i http://127.0.0.1:9000/stream.ts -read_intervals %+10 \
  | grep -E "codec_name|width|height|sample_rate|channels|bit_rate"
```

Expected: video `mpeg2video 720x576`, audio `mp2 48000 Hz 2 channels`, video bit_rate near 5000000.

- [ ] **Step 4:** Watch in VLC for 60 s. Listen for audio wobble — should be gone. Compare quality side-by-side against the page in a regular Chrome tab.

```bash
vlc http://127.0.0.1:9000/stream.ts
```

- [ ] **Step 5:** Stop.

```bash
docker rm -f wps-raw
```

- [ ] **Step 6:** Commit nothing — this is verification only. If issues, fix them in a follow-up commit before opening the PR.

---

## Task 9 — Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-04-17-av-drift-webrtc-rebuild-design.md` (add a postscript noting we pivoted)

- [ ] **Step 1:** Update the "How it works" diagram in `README.md` to the raw-frame architecture from this plan's header.

- [ ] **Step 2:** Update the "Breaking changes in 0.3.0" bullet to read: "ingest pipeline is Chromium → MediaStreamTrackProcessor → WebSocket → ffmpeg. No browser-side encoding, no mediamtx."

- [ ] **Step 3:** Append to the WebRTC design doc:

```markdown
## Postscript (2026-04-28)

Implemented and tested. Quality was poor on a fast LAN because WebRTC's
bandwidth estimator runs even on loopback and caps VP8 well below source
quality. Pivoted to raw-frame ingest via `MediaStreamTrackProcessor`; see
`docs/plans/2026-04-28-raw-frame-ingest-plan.md`. mediamtx removed.
```

- [ ] **Step 4:** Commit.

```bash
git add README.md docs/plans/2026-04-17-av-drift-webrtc-rebuild-design.md
git commit -m "docs: update for raw-frame ingest"
```

---

## Task 10 — Open PR

- [ ] **Step 1:** Push, open PR.

```bash
git push -u origin feat/raw-frame-ingest
gh pr create --title "feat: raw-frame ingest via MediaStreamTrackProcessor" \
  --body "$(cat <<'EOF'
## Summary
- Replaces WebRTC/WHIP/mediamtx ingest with raw I420 + s16le over WebSocket.
- Chromium captures the tab, splits it into VideoFrame / AudioData via
  MediaStreamTrackProcessor, and ships raw bytes to the relay.
- ffmpeg reads two named pipes — no browser-side encoding, no rate adaptation.
- Closes the quality regression on PR #20; same A/V sync guarantee.

## Test plan
- [ ] container builds clean (CI)
- [ ] /health reports both ingest sockets connected
- [ ] ffprobe of /stream.ts shows expected codecs and bitrate
- [ ] 60s VLC playback — no audio wobble, no drift
- [ ] long-soak (30 min) drift check against /test/clock.html

EOF
)"
```

- [ ] **Step 2:** Close PR #20 with a comment linking the new PR.

---

## Task 11 — Follow-up (deferred): port relay to Go

**Trigger:** open as a separate PR *after* the raw-frame ingest path is proven in production. Do not bundle into this PR.

**Rationale:** the current relay is ~600 LoC of Node doing WS server + ffmpeg child supervision + HTTP fanout + IPTV endpoints. All of that is trivial in Go and gives:
- single static binary in the image (drop `nodejs`, `npm`, `node_modules`)
- ~30 MB Alpine image vs the current ~250 MB
- no `npm ci` step at build time
- one fewer language in the project

**Out of scope for this task:** anything browser-side. The extension stays JavaScript — Chromium's renderer sandbox accepts nothing else.

**Sketch of the port:**
- `gorilla/websocket` for `/ingest/video` and `/ingest/audio` (replaces `ws`).
- `net/http` for `/stream.ts`, `/playlist.m3u`, `/guide.xml`, `/health`, `/test/clock.html`.
- `os/exec` for the ffmpeg child + auto-restart loop.
- `os.Mkfifo` (via `syscall.Mkfifo`) instead of shelling out to `mkfifo(1)`.
- HTTP fanout: keep a `sync.Map` of `http.ResponseWriter` clients, write to all under a `sync.RWMutex`. Slow client → drop, same as today.
- Profile resolution: small struct + `map[string]Profile` literal — straight port of `relay/profiles.js`.
- Build: multi-stage Dockerfile, `golang:1.23-alpine` builder → `alpine:3.21` runtime with just the static binary + ffmpeg + chromium + supervisord.
- Tests: `go test ./...` covering profile resolution, IPTV generation, ingest WS round-trip. Keep the same test surface as the Node version.

**Acceptance:** identical external behaviour — same env vars, same endpoints, same `/health` shape. Replace, don't reimagine.

---

## Open questions / decisions for the implementer

1. **Branch decision (Task 0)** — Option A vs B. Default in this plan is B.
2. **VideoFrame format** — Task 1 spike. If not I420 by default, add a `--enable-blink-features=...` flag in `start.sh`.
3. **Audio format conversion** — `AudioData.copyTo({format: "s16"})` is supported in Chromium 111+. If our base image's chromium is older, pre-convert in JS.
4. **Backpressure on stream stalls** — current design drops video frames after 8 MB WS backlog. If we'd rather pause the source than drop, we can `await` `ws.bufferedAmount` to drain. Drop is simpler and more "broadcast-like."
