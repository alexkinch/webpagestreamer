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
