// Relay server: ingests raw I420 video frames + f32le audio chunks from the
// Chrome extension over two WebSockets (see ./ingest.js for the wire protocol),
// fans them through named pipes into ffmpeg, which encodes to MPEG-TS and
// writes to the configured OUTPUT (UDP/RTP/TCP/HTTP/file).
//
// Also serves IPTV integration endpoints:
//   GET /guide.xml    — XMLTV electronic programme guide
//   GET /playlist.m3u — M3U playlist for IPTV clients
//   GET /health       — stream health check
//   GET /stream.ts    — progressive MPEG-TS (when OUTPUT=http)

const http = require("http");
const { spawn, execFileSync } = require("child_process");
const { mountIngest } = require("./ingest.js");
const dgram = require("dgram");
const net = require("net");
const fs = require("fs");
const url = require("url");
const crypto = require("crypto");

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
    sar: "12/11", interlaced: true, format: "mpegts",
  },
  ntsc: {
    width: 720, height: 480, framerate: 29.97,
    videoCodec: "mpeg2video", audioCodec: "mp2",
    videoBitrate: "5000k", audioBitrate: "256k",
    sar: "10/11", interlaced: true, format: "mpegts",
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
  hls: {
    width: 1280, height: 720, framerate: 30,
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "2500k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "hls",
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
const VIDEO_CODEC = process.env.VIDEO_CODEC || baseProfile.videoCodec;
const AUDIO_CODEC = process.env.AUDIO_CODEC || baseProfile.audioCodec;
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || baseProfile.videoBitrate;
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || baseProfile.audioBitrate;
const SAR = process.env.SAR || baseProfile.sar;
const INTERLACED = process.env.INTERLACED
  ? process.env.INTERLACED === "true"
  : baseProfile.interlaced;
const FORMAT = process.env.FORMAT || baseProfile.format;

const HLS_DIR = "/tmp/hls";
const HLS_SEGMENT_TIME = process.env.HLS_SEGMENT_TIME || "2";
const HLS_LIST_SIZE = process.env.HLS_LIST_SIZE || "5";

let ffmpeg = null;
let ffmpegReady = false;
let outputHandler = null;
let videoIngestConnected = false;
let audioIngestConnected = false;
let videoFifoWriter = null;
let audioFifoWriter = null;

// Clients connected to /stream.ts (populated when OUTPUT=http). Shared between
// the HTTP request handler and the output handler's write() fan-out.
const httpStreamClients = new Set();

// ---------------------------------------------------------------------------
// Output handlers — FFmpeg writes MPEG-TS to stdout, we forward it here
// ---------------------------------------------------------------------------

function parseOutput(outputStr) {
  // UDP:  udp://host:port?opts
  // RTP:  rtp://host:port   (MPEG-TS over RTP, RFC 2250, PT=33)
  // TCP:  tcp://host:port?opts
  // HTTP: "http" or "http://..." (progressive MPEG-TS served at /stream.ts on WS_PORT)
  // File: /path/to/file.ts
  if (outputStr.startsWith("udp://")) {
    const parsed = new URL(outputStr);
    return {
      type: "udp",
      host: parsed.hostname,
      port: parseInt(parsed.port, 10),
    };
  }
  if (outputStr.startsWith("rtp://")) {
    const parsed = new URL(outputStr);
    return {
      type: "rtp",
      host: parsed.hostname,
      port: parseInt(parsed.port, 10),
    };
  }
  if (outputStr.startsWith("tcp://")) {
    const parsed = new URL(outputStr);
    return {
      type: "tcp",
      host: parsed.hostname,
      port: parseInt(parsed.port, 10),
    };
  }
  if (outputStr === "http" || outputStr.startsWith("http://")) {
    return { type: "http" };
  }
  // Assume file path
  return { type: "file", path: outputStr };
}

function createOutputHandler(outputStr) {
  const config = parseOutput(outputStr);

  if (config.type === "udp") {
    const socket = dgram.createSocket("udp4");
    // Enable multicast if it's a multicast address (224.0.0.0 - 239.255.255.255)
    const firstOctet = parseInt(config.host.split(".")[0], 10);
    if (firstOctet >= 224 && firstOctet <= 239) {
      socket.bind(0, () => {
        socket.setMulticastTTL(4);
      });
    }
    console.log(`[output] UDP → ${config.host}:${config.port}`);
    return {
      write(chunk) {
        // MPEG-TS packets are 188 bytes; send in TS-aligned chunks
        const PKT_SIZE = 1316; // 7 x 188
        for (let i = 0; i < chunk.length; i += PKT_SIZE) {
          const pkt = chunk.slice(i, Math.min(i + PKT_SIZE, chunk.length));
          socket.send(pkt, config.port, config.host);
        }
      },
      close() {
        socket.close();
      },
    };
  }

  if (config.type === "rtp") {
    // MPEG-TS over RTP per RFC 2250: 12-byte RTP header + up to 7 TS packets.
    const socket = dgram.createSocket("udp4");
    const firstOctet = parseInt(config.host.split(".")[0], 10);
    if (firstOctet >= 224 && firstOctet <= 239) {
      socket.bind(0, () => {
        socket.setMulticastTTL(4);
      });
    }
    const ssrc = crypto.randomBytes(4).readUInt32BE(0);
    let seq = crypto.randomBytes(2).readUInt16BE(0);
    const PKT_SIZE = 1316; // 7 × 188 = max TS payload that fits under 1500 MTU
    console.log(`[output] RTP → ${config.host}:${config.port} (PT=33, SSRC=0x${ssrc.toString(16)})`);
    return {
      write(chunk) {
        for (let i = 0; i < chunk.length; i += PKT_SIZE) {
          const payload = chunk.slice(i, Math.min(i + PKT_SIZE, chunk.length));
          const header = Buffer.alloc(12);
          header[0] = 0x80;           // V=2, P=0, X=0, CC=0
          header[1] = 33;             // M=0, PT=33 (MP2T)
          header.writeUInt16BE(seq & 0xffff, 2);
          // 90 kHz wall-clock timestamp; wraps naturally at u32
          header.writeUInt32BE(((Date.now() * 90) >>> 0), 4);
          header.writeUInt32BE(ssrc, 8);
          seq = (seq + 1) & 0xffff;
          socket.send(Buffer.concat([header, payload]), config.port, config.host);
        }
      },
      close() {
        socket.close();
      },
    };
  }

  if (config.type === "tcp") {
    const clients = new Set();
    const server = net.createServer((socket) => {
      console.log(`[output] TCP client connected: ${socket.remoteAddress}:${socket.remotePort}`);
      clients.add(socket);
      socket.on("close", () => {
        console.log(`[output] TCP client disconnected`);
        clients.delete(socket);
      });
      socket.on("error", (err) => {
        console.error(`[output] TCP client error: ${err.message}`);
        clients.delete(socket);
      });
    });
    server.listen(config.port, config.host, () => {
      console.log(`[output] TCP server listening on ${config.host}:${config.port}`);
    });
    return {
      write(chunk) {
        for (const client of clients) {
          if (!client.destroyed) {
            client.write(chunk);
          }
        }
      },
      close() {
        for (const client of clients) client.destroy();
        server.close();
      },
    };
  }

  if (config.type === "http") {
    // Progressive MPEG-TS served on the main WS_PORT HTTP server at /stream.ts.
    // The route handler populates httpStreamClients; we just fan out chunks.
    console.log(`[output] HTTP progressive MPEG-TS at http://<host>:${WS_PORT}/stream.ts`);
    return {
      write(chunk) {
        for (const res of httpStreamClients) {
          if (!res.destroyed && res.writable) {
            res.write(chunk);
          }
        }
      },
      close() {
        for (const res of httpStreamClients) res.end();
        httpStreamClients.clear();
      },
    };
  }

  if (config.type === "file") {
    const stream = fs.createWriteStream(config.path);
    console.log(`[output] File → ${config.path}`);
    return {
      write(chunk) {
        stream.write(chunk);
      },
      close() {
        stream.end();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// FFmpeg — encodes raw I420 video + f32le audio to MPEG-TS on stdout
// ---------------------------------------------------------------------------

function buildFFmpegArgs() {
  const gop = String(Math.round(parseFloat(FRAMERATE) / 2));
  const args = [
    "-fflags", "+genpts",

    // Raw I420 video pipe — ffmpeg paces by -framerate.
    "-f", "rawvideo",
    "-pix_fmt", "yuv420p",
    "-s", `${WIDTH}x${HEIGHT}`,
    "-framerate", String(FRAMERATE),
    "-thread_queue_size", "1024",
    "-i", VIDEO_FIFO,

    // Raw f32le audio pipe at 44.1 kHz (browser default). The encoder's
    // -ar 48000 below makes ffmpeg resample on the fly.
    "-f", "f32le",
    "-ar", "44100",
    "-ac", "2",
    "-thread_queue_size", "1024",
    "-i", AUDIO_FIFO,

    "-c:v", VIDEO_CODEC,
    "-b:v", VIDEO_BITRATE,
    "-maxrate", VIDEO_BITRATE,
    "-bufsize", "2000k",
    "-pix_fmt", "yuv420p",
    "-g", gop,
    "-bf", "2",
  ];

  if (INTERLACED) args.push("-flags", "+ilme+ildct");
  if (VIDEO_CODEC === "libx264") args.push("-preset", "veryfast", "-tune", "zerolatency");

  args.push("-vf", `setsar=${SAR}`);

  // Output audio at 48 kHz regardless of input — ffmpeg resamples 44100→48000.
  args.push("-c:a", AUDIO_CODEC, "-b:a", AUDIO_BITRATE, "-ar", "48000", "-ac", "2");

  args.push("-fps_mode", "cfr");

  if (FORMAT === "hls") {
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

function setupPipes() {
  for (const fifo of [VIDEO_FIFO, AUDIO_FIFO]) {
    try { fs.unlinkSync(fifo); } catch {}
    execFileSync("mkfifo", [fifo]);
  }
}

function startFFmpeg() {
  // Ensure HLS output directory exists
  if (FORMAT === "hls") {
    fs.mkdirSync(HLS_DIR, { recursive: true });
  }

  // Recreate the named pipes on every spawn. The kernel pipe buffer can
  // hold partial frames from a dead ffmpeg; reading them as if fresh would
  // misalign rawvideo. unlink+mkfifo gives us a pristine fifo each life.
  setupPipes();

  const args = buildFFmpegArgs();

  console.log(`[relay] starting FFmpeg → ${FORMAT === "hls" ? "HLS" : "stdout"} (profile: ${PROFILE})`);
  console.log(`[relay]   ${VIDEO_CODEC} ${WIDTH}x${HEIGHT}@${FRAMERATE}fps SAR ${SAR}${INTERLACED ? " interlaced" : ""}`);
  console.log(`[relay]   ${AUDIO_CODEC} ${AUDIO_BITRATE} 48kHz stereo (in: 44.1 kHz)`);

  ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Open the fifo writers asynchronously so ffmpeg has a chance to open the
  // read end first; otherwise createWriteStream() blocks waiting for a reader.
  // ffmpegReady is set inside this callback so writes from the ingest WS
  // can't race ahead of valid writers.
  setImmediate(() => {
    if (videoFifoWriter) { try { videoFifoWriter.destroy(); } catch {} }
    if (audioFifoWriter) { try { audioFifoWriter.destroy(); } catch {} }
    videoFifoWriter = fs.createWriteStream(VIDEO_FIFO);
    audioFifoWriter = fs.createWriteStream(AUDIO_FIFO);
    videoFifoWriter.on("error", (e) => console.warn("[relay] video fifo error:", e.message));
    audioFifoWriter.on("error", (e) => console.warn("[relay] audio fifo error:", e.message));
    ffmpegReady = true;
  });

  // Forward MPEG-TS output to the configured destination (non-HLS only)
  ffmpeg.stdout.on("data", (chunk) => {
    if (FORMAT !== "hls" && outputHandler) {
      outputHandler.write(chunk);
    }
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
  // HLS streams are served from the built-in HTTP server
  if (FORMAT === "hls") {
    return `http://${requestHost(req)}/stream/stream.m3u8`;
  }
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
  if (OUTPUT === "http" || OUTPUT.startsWith("http://")) {
    return `http://${requestHost(req)}/stream.ts`;
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

function serveHLSFile(pathname, res) {
  const filename = pathname.replace("/stream/", "");
  // Prevent path traversal
  if (filename.includes("..") || filename.includes("/")) {
    res.writeHead(403);
    res.end();
    return;
  }
  const filePath = `${HLS_DIR}/${filename}`;
  const stream = fs.createReadStream(filePath);
  const contentType = filename.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : "video/mp2t";
  stream.on("open", () => {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    });
    stream.pipe(res);
  });
  stream.on("error", () => {
    res.writeHead(404);
    res.end();
  });
}

function handleHTTPRequest(req, res) {
  const pathname = url.parse(req.url).pathname;

  // /stream.ts — progressive MPEG-TS (only when OUTPUT=http). Handle before
  // the method gate so HEAD preflights work.
  if (pathname === "/stream.ts" && (OUTPUT === "http" || OUTPUT.startsWith("http://"))) {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "video/mp2t", "Cache-Control": "no-cache" });
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    console.log(`[output] HTTP client connected: ${req.socket.remoteAddress}`);
    res.writeHead(200, {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache, no-store",
      Connection: "close",
    });
    httpStreamClients.add(res);
    const cleanup = () => {
      if (httpStreamClients.delete(res)) {
        console.log(`[output] HTTP client disconnected`);
      }
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
    return;
  }

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
    const healthy = ffmpegReady && videoIngestConnected && audioIngestConnected
      && (FORMAT === "hls" || outputHandler !== null);
    const body = JSON.stringify({
      status: healthy ? "healthy" : "unhealthy",
      ffmpeg: ffmpegReady,
      ingest: { video: videoIngestConnected, audio: audioIngestConnected },
      profile: PROFILE,
      format: FORMAT,
      output: FORMAT === "hls" ? `http://localhost:${WS_PORT}/stream/stream.m3u8` : OUTPUT,
    });
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  // HLS segment serving: /stream/stream.m3u8, /stream/segment000.ts, etc.
  if (FORMAT === "hls" && pathname.startsWith("/stream/")) {
    serveHLSFile(pathname, res);
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

  // Mount the raw-frame WS ingest endpoints (/ingest/video, /ingest/audio).
  // The sinks are tiny shims because the underlying fifo writers get recreated
  // on every ffmpeg restart, so we can't pass a fixed Writable here.
  mountIngest(httpServer, {
    videoSink: {
      write: (chunk) => { if (videoFifoWriter) videoFifoWriter.write(chunk); },
    },
    audioSink: {
      write: (chunk) => { if (audioFifoWriter) audioFifoWriter.write(chunk); },
    },
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
    if (FORMAT === "hls") {
      console.log(`[relay]   GET /stream/*     — HLS live stream`);
    }
    if (OUTPUT === "http" || OUTPUT.startsWith("http://")) {
      console.log(`[relay]   GET /stream.ts    — progressive MPEG-TS`);
    }
  });
}

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

if (FORMAT !== "hls") {
  outputHandler = createOutputHandler(OUTPUT);
}
startFFmpeg();
startServer();
