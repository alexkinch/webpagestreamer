// Relay server: ingests raw I420 video frames + f32le audio chunks from the
// Chrome extension over two WebSockets (see ./ingest.js for the wire protocol),
// fans them through named pipes into ffmpeg, which encodes to MPEG-TS and
// pushes to the configured OUTPUT destination.
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
const { mountIngest } = require("./ingest.js");
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

const VIDEO_FIFO = "/tmp/video.fifo";
const AUDIO_FIFO = "/tmp/audio.fifo";

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
const FRAMERATE = process.env.FRAMERATE || String(baseProfile.framerate);
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
let videoFifoWriter = null;
let audioFifoWriter = null;

// ---------------------------------------------------------------------------
// FFmpeg — encodes raw I420 video + f32le audio to MPEG-TS on stdout
// ---------------------------------------------------------------------------

function buildFFmpegArgs() {
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

    // Raw f32le audio pipe at 44.1 kHz. Encoder's -ar 48000 below resamples.
    "-f", "f32le",
    "-ar", "44100",
    "-ac", "2",
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

  // Output audio at 48 kHz regardless of input — ffmpeg resamples 44100→48000.
  // aresample=async=1000 continuously stretches/compresses audio (up to 1000
  // samples per chunk) to track the video's clock. Without this the two
  // declared rates (44.1 kHz audio, 25 fps video) drift relative to each
  // other because the browser's compositor isn't a metronome — measured 2%
  // divergence over 10 s with the BBC sync test.
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

function setupPipes() {
  for (const fifo of [VIDEO_FIFO, AUDIO_FIFO]) {
    try { fs.unlinkSync(fifo); } catch {}
    execFileSync("mkfifo", [fifo]);
  }
}

function startFFmpeg() {
  // Recreate the named pipes on every spawn. The kernel pipe buffer can
  // hold partial frames from a dead ffmpeg; reading them as if fresh would
  // misalign rawvideo. unlink+mkfifo gives us a pristine fifo each life.
  setupPipes();

  const args = buildFFmpegArgs();

  console.log(`[relay] starting FFmpeg → ${OUTPUT} (profile: ${PROFILE})`);
  console.log(`[relay]   ${VIDEO_CODEC} ${WIDTH}x${HEIGHT}@${FRAMERATE}fps SAR ${SAR}${INTERLACED ? " interlaced" : ""}`);
  console.log(`[relay]   ${AUDIO_CODEC} ${AUDIO_BITRATE} 48kHz stereo (in: 44.1 kHz)`);

  ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Open the fifo writers asynchronously so ffmpeg has a chance to open the
  // read end first; otherwise createWriteStream() blocks waiting for a reader.
  // ffmpegReady is set inside this callback so writes from the ingest WS
  // can't race ahead of valid writers.
  setImmediate(() => {
    if (videoFifoWriter) { try { videoFifoWriter.destroy(); } catch {} }
    if (audioFifoWriter) { try { audioFifoWriter.destroy(); } catch {} }
    videoFifoWriter = fs.createWriteStream(VIDEO_FIFO, { highWaterMark: VIDEO_FRAME_SIZE * 2 });
    audioFifoWriter = fs.createWriteStream(AUDIO_FIFO, { highWaterMark: 44100 * 2 * 4 });
    videoFifoWriter.on("error", (e) => console.warn("[relay] video fifo error:", e.message));
    audioFifoWriter.on("error", (e) => console.warn("[relay] audio fifo error:", e.message));
    ffmpegReady = true;
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
    videoFifoWriter = null;
    audioFifoWriter = null;
  });

  ffmpeg.on("exit", (code, signal) => {
    console.log(`[relay] FFmpeg exited: code=${code} signal=${signal}`);
    ffmpegReady = false;
    videoFifoWriter = null;
    audioFifoWriter = null;
    // Restart FFmpeg after a delay
    setTimeout(startFFmpeg, 2000);
  });
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
    const healthy = ffmpegReady && videoIngestConnected && audioIngestConnected;
    const body = JSON.stringify({
      status: healthy ? "healthy" : "unhealthy",
      ffmpeg: ffmpegReady,
      ingest: { video: videoIngestConnected, audio: audioIngestConnected },
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
// HTTP server + raw-frame ingest
// ---------------------------------------------------------------------------

function startServer() {
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
      sampleRate: 44100,
      channels: 2,
    },
    onVideoConnect: (b) => { videoIngestConnected = b; },
    onAudioConnect: (b) => { audioIngestConnected = b; },
  });

  httpServer.listen(WS_PORT, () => {
    console.log(`[relay] HTTP server listening on port ${WS_PORT}`);
    console.log(`[relay]   GET /guide.xml    — XMLTV programme guide`);
    console.log(`[relay]   GET /playlist.m3u — M3U playlist`);
    console.log(`[relay]   GET /health       — health check`);
  });
}

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

startFFmpeg();
startServer();
