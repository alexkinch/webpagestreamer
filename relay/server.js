// WebSocket relay server: receives WebM chunks from the Chrome extension,
// pipes them into FFmpeg (which encodes to MPEG-TS on stdout), and forwards
// the MPEG-TS output to the configured destination (UDP, TCP, or file).
//
// Also serves IPTV integration endpoints:
//   GET /guide.xml   — XMLTV electronic programme guide
//   GET /playlist.m3u — M3U playlist for IPTV clients
//   GET /health       — stream health check

const http = require("http");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const dgram = require("dgram");
const net = require("net");
const fs = require("fs");
const url = require("url");

const WS_PORT = parseInt(process.env.WS_PORT || "9000", 10);
const OUTPUT = process.env.OUTPUT || "udp://239.0.0.1:1234?pkt_size=1316";
const WIDTH = process.env.WIDTH || "720";
const HEIGHT = process.env.HEIGHT || "576";
const FRAMERATE = process.env.FRAMERATE || "25";
const CHANNEL_NAME = process.env.CHANNEL_NAME || "WebPageStreamer";
const CHANNEL_ID = process.env.CHANNEL_ID || "webpagestreamer.1";
const PROGRAMME_TITLE = process.env.PROGRAMME_TITLE || "Live Stream";
const PROGRAMME_DESC = process.env.PROGRAMME_DESC || "";
const STREAM_URL = process.env.STREAM_URL || "";

let ffmpeg = null;
let ffmpegReady = false;
let outputHandler = null;
let wsConnected = false;

// ---------------------------------------------------------------------------
// Output handlers — FFmpeg writes MPEG-TS to stdout, we forward it here
// ---------------------------------------------------------------------------

function parseOutput(outputStr) {
  // UDP:  udp://host:port?opts
  // TCP:  tcp://host:port?opts
  // File: /path/to/file.ts
  if (outputStr.startsWith("udp://")) {
    const parsed = new URL(outputStr);
    return {
      type: "udp",
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
// FFmpeg — encodes WebM to MPEG-TS, outputs on stdout
// ---------------------------------------------------------------------------

function startFFmpeg() {
  const args = [
    // Input: WebM from stdin
    "-i", "pipe:0",
    // Video: MPEG-2 (standard for PAL DVB/analogue)
    "-c:v", "mpeg2video",
    "-s", `${WIDTH}x${HEIGHT}`,
    "-r", FRAMERATE,
    "-b:v", "5000k",
    "-maxrate", "5000k",
    "-bufsize", "2000k",
    "-pix_fmt", "yuv420p",
    "-g", String(parseInt(FRAMERATE, 10) / 2), // GOP = 0.5 seconds (fast channel join)
    "-bf", "2",
    "-flags", "+ilme+ildct",
    "-vf", "setsar=12/11", // PAL 4:3 SAR (ITU BT.601)
    // Audio: MPEG-2 layer 2 (standard for PAL broadcast)
    "-c:a", "mp2",
    "-b:a", "256k",
    "-ar", "48000",
    "-ac", "2",
    // Sync and format — output MPEG-TS to stdout
    "-fps_mode", "cfr",
    "-async", "1",
    "-f", "mpegts",
    "pipe:1",
  ];

  console.log(`[relay] starting FFmpeg → stdout (MPEG-TS)`);
  ffmpeg = spawn("ffmpeg", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  ffmpegReady = true;

  // Forward MPEG-TS output to the configured destination
  ffmpeg.stdout.on("data", (chunk) => {
    if (outputHandler) {
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
  });

  ffmpeg.on("exit", (code, signal) => {
    console.log(`[relay] FFmpeg exited: code=${code} signal=${signal}`);
    ffmpegReady = false;
    // Restart FFmpeg after a delay
    setTimeout(startFFmpeg, 2000);
  });

  ffmpeg.stdin.on("error", (err) => {
    console.error("[relay] FFmpeg stdin error:", err.message);
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

function deriveStreamURL() {
  if (STREAM_URL) return STREAM_URL;
  // Derive from OUTPUT — for UDP multicast, prefix with @ for client join
  if (OUTPUT.startsWith("udp://")) {
    const parsed = new URL(OUTPUT);
    return `udp://@${parsed.hostname}:${parsed.port}`;
  }
  if (OUTPUT.startsWith("tcp://")) {
    const parsed = new URL(OUTPUT);
    return `tcp://${parsed.hostname}:${parsed.port}`;
  }
  return OUTPUT;
}

function generateM3U() {
  const streamUrl = deriveStreamURL();
  return `#EXTM3U
#EXTINF:-1 tvg-id="${CHANNEL_ID}" tvg-name="${CHANNEL_NAME}" group-title="${CHANNEL_NAME}",${CHANNEL_NAME}
${streamUrl}
`;
}

function handleHTTPRequest(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }

  const pathname = url.parse(req.url).pathname;

  if (pathname === "/guide.xml") {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(generateXMLTV());
    return;
  }

  if (pathname === "/playlist.m3u") {
    res.writeHead(200, { "Content-Type": "audio/x-mpegurl" });
    res.end(generateM3U());
    return;
  }

  if (pathname === "/health") {
    const healthy = ffmpegReady && wsConnected && outputHandler !== null;
    const body = JSON.stringify({
      status: healthy ? "healthy" : "unhealthy",
      ffmpeg: ffmpegReady,
      websocket: wsConnected,
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
// WebSocket + HTTP server
// ---------------------------------------------------------------------------

function startServer() {
  const httpServer = http.createServer(handleHTTPRequest);

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket) => {
    console.log("[relay] extension connected");
    wsConnected = true;

    socket.on("message", (data, isBinary) => {
      if (isBinary && ffmpegReady && ffmpeg && ffmpeg.stdin.writable) {
        ffmpeg.stdin.write(Buffer.from(data));
      }
    });

    socket.on("close", () => {
      console.log("[relay] extension disconnected");
      wsConnected = wss.clients.size > 0;
    });

    socket.on("error", (err) => {
      console.error("[relay] WebSocket error:", err.message);
    });
  });

  httpServer.listen(WS_PORT, () => {
    console.log(`[relay] WebSocket + HTTP server listening on port ${WS_PORT}`);
    console.log(`[relay]   GET /guide.xml   — XMLTV programme guide`);
    console.log(`[relay]   GET /playlist.m3u — M3U playlist`);
    console.log(`[relay]   GET /health       — health check`);
  });
}

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

outputHandler = createOutputHandler(OUTPUT);
startFFmpeg();
startServer();
