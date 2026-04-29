// Relay server: ingests from the Chrome extension and feeds FFmpeg → MPEG-TS → OUTPUT.
// Default (INGEST_MODE=webm): muxed WebM on /ingest/webm → FFmpeg stdin.
// Legacy (INGEST_MODE=raw): I420 + f32le PCM on two sockets → named pipes (see ingest.js).
//
// OUTPUT modes (all native ffmpeg outputs — no custom Node networking):
//   udp://host:port   — UDP / multicast (raw MPEG-TS). Standard for IPTV.
//   rtp://host:port   — MPEG-TS over RTP (RFC 2250)
//   tcp://host:port   — TCP listener (raw MPEG-TS, single concurrent client)
//   /path/to/file.ts  — write to file
//
// For multi-client HTTP / HLS / RTSP / WebRTC fanout, run mediamtx (or
// mptsd, nginx-rtmp, etc.) downstream and aim OUTPUT at it — e.g.
// OUTPUT=udp://<mediamtx-host>:9999 with mediamtx ingesting MPEG-TS-UDP.
//
// Also serves IPTV integration endpoints on WS_PORT:
//   GET /guide.xml    — XMLTV electronic programme guide
//   GET /playlist.m3u — M3U playlist for IPTV clients
//   GET /health       — stream health check

const http = require("http");
const { spawn, execFileSync } = require("child_process");
const { mountIngest, mountIngestWebm } = require("./ingest.js");
const fs = require("fs");
const url = require("url");

const WS_PORT = parseInt(process.env.WS_PORT || "9000", 10);
const OUTPUT = process.env.OUTPUT || "udp://239.0.0.1:1234?pkt_size=1316";
const PROFILE = process.env.PROFILE || "pal";
const CHANNEL_NAME = process.env.CHANNEL_NAME || "WebPageStreamer";
const CHANNEL_ID = process.env.CHANNEL_ID || "webpagestreamer.1";
const PROGRAMME_TITLE = process.env.PROGRAMME_TITLE || "Live Stream";
const PROGRAMME_DESC = process.env.PROGRAMME_DESC || "";
const STREAM_URL = process.env.STREAM_URL || "";
// webm = single muxed MediaRecorder stream (A/V timestamps from Chrome). raw =
// legacy dual WebSocket I420 + PCM (no shared timeline — drifts under load).
const INGEST_MODE = (process.env.INGEST_MODE || "webm").toLowerCase();

const VIDEO_FIFO = "/tmp/video.fifo";
const AUDIO_FIFO = "/tmp/audio.fifo";
const FFMPEG_READY_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Encoding profiles — each bundles resolution, codec, and format defaults
// ---------------------------------------------------------------------------

const PROFILES = {
  pal: {
    width: 720, height: 576, framerate: 25,
    videoCodec: "mpeg2video", audioCodec: "mp2",
    videoBitrate: "5000k", audioBitrate: "256k",
    // Source is inherently progressive (Chromium renders full frames at
    // the requested rate). Encoding interlaced from a progressive source
    // produces field-pair flicker on bob-deinterlacing players. Default
    // off; set INTERLACED=true if you specifically need broadcast PAL.
    sar: "12/11", interlaced: false, format: "mpegts",
  },
  ntsc: {
    width: 720, height: 480, framerate: 29.97,
    videoCodec: "mpeg2video", audioCodec: "mp2",
    videoBitrate: "5000k", audioBitrate: "256k",
    sar: "10/11", interlaced: false, format: "mpegts",
  },
  "720p": {
    width: 1280, height: 720, framerate: 30,
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "2500k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "mpegts",
  },
  "1080p": {
    width: 1920, height: 1080, framerate: 30,
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "5000k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "mpegts",
  },
};

const baseProfile = PROFILES[PROFILE] || PROFILES.pal;
if (!PROFILES[PROFILE]) {
  console.warn(`[relay] Unknown profile "${PROFILE}", falling back to "pal"`);
}

// Environment overrides take precedence over profile defaults
const WIDTH = process.env.WIDTH || String(baseProfile.width);
const HEIGHT = process.env.HEIGHT || String(baseProfile.height);
const FRAMERATE = process.env.FRAMERATE || (INGEST_MODE === "webm" ? "60" : String(baseProfile.framerate));
const VIDEO_FRAME_SIZE = parseInt(WIDTH, 10) * parseInt(HEIGHT, 10) * 3 / 2;
const VIDEO_CODEC = process.env.VIDEO_CODEC || baseProfile.videoCodec;
const AUDIO_CODEC = process.env.AUDIO_CODEC || baseProfile.audioCodec;
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || baseProfile.videoBitrate;
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || baseProfile.audioBitrate;
const B_FRAMES = process.env.B_FRAMES || "0";
const SAR = process.env.SAR || baseProfile.sar;
const INTERLACED = process.env.INTERLACED
  ? process.env.INTERLACED === "true"
  : baseProfile.interlaced;
let ffmpeg = null;
let ffmpegReady = false;
let videoIngestConnected = false;
let audioIngestConnected = false;
let webmIngestConnected = false;
let videoFifoWriter = null;
let audioFifoWriter = null;
let audioInput = null;
let ffmpegRestartTimer = null;
let videoWriterReady = false;
let audioWriterReady = false;
let videoWriterReadyWaiters = [];
let audioWriterReadyWaiters = [];

// ---------------------------------------------------------------------------
// FFmpeg — encodes raw I420 video + f32le audio to MPEG-TS on stdout
// ---------------------------------------------------------------------------

function buildFFmpegArgs(inputAudio) {
  const gop = String(Math.round(parseFloat(FRAMERATE) / 2));
  const args = [
    "-fflags", "+genpts",

    // Raw I420 video pipe. The extension throttles to exactly FRAMERATE
    // before sending, so we can use the simple sample-count clock here:
    // each frame read from the fifo is stamped at N × (1/FRAMERATE) sec.
    // Wallclock-stamped PTS would just import any browser jitter and make
    // -fps_mode cfr churn out duplicates.
    "-f", "rawvideo",
    "-pix_fmt", "yuv420p",
    "-s", `${WIDTH}x${HEIGHT}`,
    "-framerate", String(FRAMERATE),
    "-thread_queue_size", "64",
    "-i", VIDEO_FIFO,

    // Raw f32le audio pipe using the exact rate/channel count Chrome reports
    // from AudioData. Raw PCM has no headers, so this must match the browser
    // capture stream or ffmpeg will play audio at the wrong speed.
    "-f", "f32le",
    "-ar", String(inputAudio.sampleRate),
    "-ac", String(inputAudio.channels),
    "-thread_queue_size", "64",
    "-i", AUDIO_FIFO,

    "-c:v", VIDEO_CODEC,
    "-b:v", VIDEO_BITRATE,
    "-maxrate", VIDEO_BITRATE,
    "-bufsize", "2000k",
    "-pix_fmt", "yuv420p",
    "-g", gop,
    "-bf", B_FRAMES,
  ];

  if (INTERLACED) args.push("-flags", "+ilme+ildct");
  if (VIDEO_CODEC === "libx264") args.push("-preset", "veryfast", "-tune", "zerolatency");

  // Tag field order explicitly. Without setfield, mpeg2video sometimes
  // marks output as bottom-first even on progressive input, which makes
  // bob-deinterlacing players flicker.
  const fieldTag = INTERLACED ? "tff" : "prog";
  args.push("-vf", `setsar=${SAR},setfield=${fieldTag}`);

  // Output audio at 48 kHz for MPEG-TS/broadcast compatibility. The input
  // side above is negotiated from Chrome, so this is a normal resample rather
  // than a guess about the browser's native capture clock.
  args.push("-c:a", AUDIO_CODEC, "-b:a", AUDIO_BITRATE, "-ar", "48000", "-ac", "2");
  args.push("-af", "aresample=async=1000");

  args.push("-fps_mode", "cfr");

  // ffmpeg writes the MPEG-TS directly to the OUTPUT URL — no Node in the
  // hot path. Native ffmpeg protocols handle udp / rtp / tcp / file.
  args.push(
    "-flush_packets", "1",
    "-f", "mpegts",
    "-mpegts_flags", "+resend_headers",
    "-muxdelay", "0",
    "-muxpreload", "0",
    OUTPUT,
  );

  return args;
}

function buildFFmpegArgsWebm() {
  const gop = String(Math.round(parseFloat(FRAMERATE) / 2));
  const fieldTag = INTERLACED ? "tff" : "prog";
  // MediaRecorder WebM often reports a bogus time base (e.g. 1k tbn); without
  // forcing CFR here FFmpeg can invent ~240fps output and mpeg2video then hits
  // "impossible bitrate constraints" / rc buffer underflow at 5 Mbit/s.
  const vf = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=${FRAMERATE},setsar=${SAR},setfield=${fieldTag}`;
  const args = [
    "-hide_banner",
    // Do not discardcorrupt on live WebM — can drop real audio after any glitch.
    "-fflags", "+genpts",
    "-analyzeduration", "10000000",
    "-probesize", "10000000",
    "-thread_queue_size", "512",
    "-f", "webm",
    "-i", "-",
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-vf", vf,
    "-c:v", VIDEO_CODEC,
    "-b:v", VIDEO_BITRATE,
    "-maxrate", VIDEO_BITRATE,
    // mpeg2video VBV: bufsize << maxrate triggers "impossible bitrate constraints"
    // and unstable RC; match buffer to peak for fewer spikes into audio starvation.
    "-bufsize", VIDEO_BITRATE,
    "-pix_fmt", "yuv420p",
    "-g", gop,
    "-bf", B_FRAMES,
    "-fps_mode", "cfr",
  ];

  if (INTERLACED) args.push("-flags", "+ilme+ildct");
  if (VIDEO_CODEC === "libx264") args.push("-preset", "veryfast", "-tune", "zerolatency");

  args.push(
    "-c:a", AUDIO_CODEC,
    "-b:a", AUDIO_BITRATE,
    "-ar", "48000",
    "-ac", "2",
    // WebM A/V is already muxed at 48 kHz — do not use aresample=async here; it
    // time-stretches audio and causes audible “pitch wobble” when compensating.
    "-flush_packets", "1",
    "-f", "mpegts",
    "-mpegts_flags", "+resend_headers",
    "-muxdelay", "0",
    "-muxpreload", "0.04",
    OUTPUT,
  );

  return args;
}

function killWebmFfmpegProcess() {
  if (!ffmpeg) return;
  try {
    ffmpeg.stdin.end();
  } catch {}
  try {
    ffmpeg.kill("SIGTERM");
  } catch {}
  ffmpeg = null;
  ffmpegReady = false;
}

function startWebmFFmpeg() {
  if (ffmpeg) return;
  if (ffmpegRestartTimer) {
    clearTimeout(ffmpegRestartTimer);
    ffmpegRestartTimer = null;
  }

  const args = buildFFmpegArgsWebm();

  console.log(`[relay] starting FFmpeg (webm ingest) → ${OUTPUT} (profile: ${PROFILE})`);
  console.log(`[relay]   in: WebM on stdin → ${VIDEO_CODEC} + ${AUDIO_CODEC} @ 48 kHz stereo`);

  ffmpeg = spawn("ffmpeg", args, {
    stdio: ["pipe", "ignore", "pipe"],
  });

  ffmpegReady = true;
  ffmpeg.stdin.on("error", () => {});

  ffmpeg.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line) {
      if (line.startsWith("frame=") || line.startsWith("size=")) {
        if (Math.random() < 0.01) {
          console.log(`[ffmpeg] ${line}`);
        }
      } else {
        console.log(`[ffmpeg] ${line}`);
      }
    }
  });

  ffmpeg.on("error", (err) => {
    console.error("[relay] FFmpeg process error:", err.message);
    ffmpegReady = false;
    ffmpeg = null;
  });

  ffmpeg.on("exit", (code, signal) => {
    console.log(`[relay] FFmpeg exited: code=${code} signal=${signal}`);
    ffmpeg = null;
    ffmpegReady = false;
  });
}

async function prepareWebmIngest() {
  killWebmFfmpegProcess();
  await new Promise((resolve) => setImmediate(resolve));
  startWebmFFmpeg();
}

function webmStdinSink() {
  return {
    write(chunk) {
      if (!ffmpeg || !ffmpeg.stdin || ffmpeg.stdin.destroyed) return true;
      return ffmpeg.stdin.write(chunk);
    },
    once(event, cb) {
      if (!ffmpeg || !ffmpeg.stdin || ffmpeg.stdin.destroyed) {
        setImmediate(cb);
        return;
      }
      ffmpeg.stdin.once(event, cb);
    },
  };
}

function sameAudioInput(a, b) {
  return Boolean(a && b && a.sampleRate === b.sampleRate && a.channels === b.channels);
}

function audioInputLabel(inputAudio) {
  return `${inputAudio.sampleRate}Hz ${inputAudio.channels}ch`;
}

function waitForWriterReady(kind) {
  const ready = kind === "video" ? videoWriterReady : audioWriterReady;
  if (ready) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const waiters = kind === "video" ? videoWriterReadyWaiters : audioWriterReadyWaiters;
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        if (kind === "video") {
          videoWriterReadyWaiters = videoWriterReadyWaiters.filter((item) => item !== waiter);
        } else {
          audioWriterReadyWaiters = audioWriterReadyWaiters.filter((item) => item !== waiter);
        }
        reject(new Error(`timed out waiting for ${kind} fifo writer to become ready`));
      }, FFMPEG_READY_TIMEOUT_MS),
    };
    waiters.push(waiter);
  });
}

function resolveWriterReadyWaiters(kind) {
  const waiters = kind === "video" ? videoWriterReadyWaiters : audioWriterReadyWaiters;
  if (kind === "video") {
    videoWriterReadyWaiters = [];
  } else {
    audioWriterReadyWaiters = [];
  }
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

function destroyFifoWriters() {
  if (videoFifoWriter) {
    try { videoFifoWriter.destroy(); } catch {}
  }
  if (audioFifoWriter) {
    try { audioFifoWriter.destroy(); } catch {}
  }
  videoFifoWriter = null;
  audioFifoWriter = null;
  videoWriterReady = false;
  audioWriterReady = false;
  ffmpegReady = false;
}

function setupPipes() {
  for (const fifo of [VIDEO_FIFO, AUDIO_FIFO]) {
    try { fs.unlinkSync(fifo); } catch {}
    execFileSync("mkfifo", [fifo]);
  }
}

function startFFmpeg() {
  if (!audioInput) {
    console.log("[relay] waiting for Chrome audio format before starting FFmpeg");
    return;
  }
  if (ffmpeg) return;
  if (ffmpegRestartTimer) {
    clearTimeout(ffmpegRestartTimer);
    ffmpegRestartTimer = null;
  }

  // Recreate the named pipes on every spawn. The kernel pipe buffer can
  // hold partial frames from a dead ffmpeg; reading them as if fresh would
  // misalign rawvideo. unlink+mkfifo gives us a pristine fifo each life.
  setupPipes();

  const args = buildFFmpegArgs(audioInput);

  console.log(`[relay] starting FFmpeg → ${OUTPUT} (profile: ${PROFILE})`);
  console.log(`[relay]   ${VIDEO_CODEC} ${WIDTH}x${HEIGHT}@${FRAMERATE}fps SAR ${SAR}${INTERLACED ? " interlaced" : ""}`);
  console.log(`[relay]   ${AUDIO_CODEC} ${AUDIO_BITRATE} 48kHz stereo (in: ${audioInputLabel(audioInput)})`);

  ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Open the fifo writers asynchronously so ffmpeg has a chance to open the
  // read end first; otherwise createWriteStream() blocks waiting for a reader.
  // ffmpegReady is set only after both FIFO write ends are open. Video
  // upgrades wait for the video writer; audio can connect earlier and starts
  // writing once ffmpeg reaches the audio fifo.
  setImmediate(() => {
    destroyFifoWriters();
    videoFifoWriter = fs.createWriteStream(VIDEO_FIFO, { highWaterMark: VIDEO_FRAME_SIZE * 2 });
    audioFifoWriter = fs.createWriteStream(AUDIO_FIFO, {
      highWaterMark: audioInput.sampleRate * audioInput.channels * 4,
    });
    videoFifoWriter.on("error", (e) => console.warn("[relay] video fifo error:", e.message));
    audioFifoWriter.on("error", (e) => console.warn("[relay] audio fifo error:", e.message));

    const markVideoOpen = () => {
      videoWriterReady = true;
      console.log("[relay] video FIFO writer ready");
      resolveWriterReadyWaiters("video");
      ffmpegReady = videoWriterReady && audioWriterReady;
    };
    const markAudioOpen = () => {
      audioWriterReady = true;
      ffmpegReady = videoWriterReady && audioWriterReady;
      console.log("[relay] audio FIFO writer ready");
      resolveWriterReadyWaiters("audio");
    };
    videoFifoWriter.once("open", markVideoOpen);
    audioFifoWriter.once("open", markAudioOpen);
  });

  ffmpeg.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line) {
      if (line.startsWith("frame=") || line.startsWith("size=")) {
        if (Math.random() < 0.01) {
          console.log(`[ffmpeg] ${line}`);
        }
      } else {
        console.log(`[ffmpeg] ${line}`);
      }
    }
  });

  ffmpeg.on("error", (err) => {
    console.error("[relay] FFmpeg process error:", err.message);
    ffmpegReady = false;
    destroyFifoWriters();
  });

  ffmpeg.on("exit", (code, signal) => {
    console.log(`[relay] FFmpeg exited: code=${code} signal=${signal}`);
    ffmpeg = null;
    ffmpegReady = false;
    destroyFifoWriters();
    // Restart FFmpeg after a delay, preserving the negotiated Chrome audio
    // format. If Chrome reconnects with a different format before then,
    // configureAudioInput() updates audioInput before the restart.
    if (audioInput) {
      ffmpegRestartTimer = setTimeout(startFFmpeg, 2000);
    }
  });
}

function configureAudioInput(params) {
  const next = {
    sampleRate: params.sampleRate,
    channels: params.channels,
  };

  if (!audioInput) {
    audioInput = next;
    console.log(`[relay] negotiated Chrome audio input: ${audioInputLabel(audioInput)}`);
    startFFmpeg();
    return Promise.resolve();
  }

  if (sameAudioInput(audioInput, next)) {
    if (!ffmpeg && !ffmpegRestartTimer) {
      startFFmpeg();
    }
    return Promise.resolve();
  }

  console.log(`[relay] Chrome audio input changed: ${audioInputLabel(audioInput)} → ${audioInputLabel(next)}; restarting FFmpeg`);
  audioInput = next;
  ffmpegReady = false;
  destroyFifoWriters();

  if (ffmpeg) {
    try { ffmpeg.kill("SIGTERM"); } catch {}
  } else {
    startFFmpeg();
  }

  return Promise.resolve();
}

function waitForVideoInput() {
  if (!audioInput) {
    throw new Error("audio format has not been negotiated yet");
  }
  return waitForWriterReady("video");
}

// ---------------------------------------------------------------------------
// IPTV endpoints — XMLTV guide, M3U playlist, health check
// ---------------------------------------------------------------------------

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

function escapeXML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateXMLTV() {
  const now = new Date();
  // Start 1 hour ago so current time always falls within a programme block
  const start = new Date(now.getTime() - 60 * 60 * 1000);

  let programmes = "";
  for (let i = 0; i < 25; i++) {
    const pStart = new Date(start.getTime() + i * 60 * 60 * 1000);
    const pStop = new Date(start.getTime() + (i + 1) * 60 * 60 * 1000);
    programmes += `  <programme start="${formatXMLTVDate(pStart)}" stop="${formatXMLTVDate(pStop)}" channel="${escapeXML(CHANNEL_ID)}">
    <title lang="en">${escapeXML(PROGRAMME_TITLE)}</title>
    <desc lang="en">${escapeXML(PROGRAMME_DESC)}</desc>
  </programme>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="webpagestreamer">
  <channel id="${escapeXML(CHANNEL_ID)}">
    <display-name>${escapeXML(CHANNEL_NAME)}</display-name>
  </channel>
${programmes}</tv>
`;
}

// Host for HTTP/HLS URLs in the M3U. Uses the incoming request's Host header so
// the URL is reachable from whoever fetched the playlist (Dispatcharr, VLC, etc.)
// rather than a meaningless "localhost".
function requestHost(req) {
  return req.headers.host || `localhost:${WS_PORT}`;
}

function deriveStreamURL(req) {
  if (STREAM_URL) return STREAM_URL;
  // Derive from OUTPUT — for UDP multicast, prefix with @ for client join
  if (OUTPUT.startsWith("udp://")) {
    const parsed = new URL(OUTPUT);
    return `udp://@${parsed.hostname}:${parsed.port}`;
  }
  if (OUTPUT.startsWith("rtp://")) {
    const parsed = new URL(OUTPUT);
    return `rtp://@${parsed.hostname}:${parsed.port}`;
  }
  if (OUTPUT.startsWith("tcp://")) {
    const parsed = new URL(OUTPUT);
    return `tcp://${parsed.hostname}:${parsed.port}`;
  }
  return OUTPUT;
}

function generateM3U(req) {
  const streamUrl = deriveStreamURL(req);
  return `#EXTM3U
#EXTINF:-1 tvg-id="${CHANNEL_ID}" tvg-name="${CHANNEL_NAME}" group-title="${CHANNEL_NAME}",${CHANNEL_NAME}
${streamUrl}
`;
}

function handleHTTPRequest(req, res) {
  const pathname = url.parse(req.url).pathname;

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }

  if (pathname === "/guide.xml") {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(generateXMLTV());
    return;
  }

  if (pathname === "/playlist.m3u") {
    res.writeHead(200, { "Content-Type": "audio/x-mpegurl" });
    res.end(generateM3U(req));
    return;
  }

  if (pathname === "/health") {
    const healthy =
      INGEST_MODE === "webm"
        ? ffmpegReady && webmIngestConnected
        : ffmpegReady && videoIngestConnected && audioIngestConnected;
    const body = JSON.stringify({
      status: healthy ? "healthy" : "unhealthy",
      ffmpeg: ffmpegReady,
      ingest:
        INGEST_MODE === "webm"
          ? { webm: webmIngestConnected }
          : { video: videoIngestConnected, audio: audioIngestConnected },
      ingestMode: INGEST_MODE,
      audioInput: INGEST_MODE === "webm" ? null : audioInput,
      profile: PROFILE,
      output: OUTPUT,
    });
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  res.writeHead(404);
  res.end();
}

// ---------------------------------------------------------------------------
// HTTP server + ingest (WebM muxed or raw dual-socket)
// ---------------------------------------------------------------------------

function startRawFrameServer() {
  const httpServer = http.createServer(handleHTTPRequest);

  function fifoSink(getWriter) {
    return {
      write(chunk) {
        const writer = getWriter();
        if (!writer || writer.destroyed) return true;
        return writer.write(chunk);
      },
      once(event, cb) {
        const writer = getWriter();
        if (!writer || writer.destroyed) {
          setImmediate(cb);
          return;
        }
        writer.once(event, cb);
      },
    };
  }

  // Mount the raw-frame WS ingest endpoints (/ingest/video, /ingest/audio).
  // The sinks are tiny shims because the underlying fifo writers get recreated
  // on every ffmpeg restart, so we can't pass a fixed Writable here.
  mountIngest(httpServer, {
    videoSink: fifoSink(() => videoFifoWriter),
    audioSink: fifoSink(() => audioFifoWriter),
    expected: {
      width: parseInt(WIDTH, 10),
      height: parseInt(HEIGHT, 10),
      framerate: parseFloat(FRAMERATE),
    },
    onVideoParams: waitForVideoInput,
    onAudioParams: configureAudioInput,
    onVideoConnect: (b) => { videoIngestConnected = b; },
    onAudioConnect: (b) => { audioIngestConnected = b; },
  });

  httpServer.listen(WS_PORT, () => {
    console.log(`[relay] HTTP server listening on port ${WS_PORT} (ingest: raw I420+PCM)`);
    console.log(`[relay]   GET /guide.xml    — XMLTV programme guide`);
    console.log(`[relay]   GET /playlist.m3u — M3U playlist`);
    console.log(`[relay]   GET /health       — health check`);
  });

  console.log("[relay] waiting for Chrome audio format before starting FFmpeg");
}

function startWebmServer() {
  const httpServer = http.createServer(handleHTTPRequest);

  mountIngestWebm(httpServer, {
    streamSink: webmStdinSink(),
    onStreamConnect: (connected) => {
      webmIngestConnected = connected;
    },
    onBeforeUpgrade: prepareWebmIngest,
    onNoActiveClients: killWebmFfmpegProcess,
  });

  httpServer.listen(WS_PORT, () => {
    console.log(`[relay] HTTP server listening on port ${WS_PORT} (ingest: webm)`);
    console.log(`[relay]   GET /guide.xml    — XMLTV programme guide`);
    console.log(`[relay]   GET /playlist.m3u — M3U playlist`);
    console.log(`[relay]   GET /health       — health check`);
  });

  console.log("[relay] waiting for WebM ingest on /ingest/webm");
}

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

if (INGEST_MODE === "webm") {
  startWebmServer();
} else if (INGEST_MODE === "raw") {
  startRawFrameServer();
} else {
  console.error(`[relay] Unknown INGEST_MODE="${INGEST_MODE}" (expected webm or raw)`);
  process.exit(1);
}
