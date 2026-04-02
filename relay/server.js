// WebSocket relay server: receives WebM chunks from the Chrome extension,
// pipes them into FFmpeg (which encodes to MPEG-TS on stdout), and forwards
// the MPEG-TS output to the configured destination (UDP, TCP, or file).

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

let ffmpeg = null;
let ffmpegReady = false;
let outputHandler = null;

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
    // Video: H.264 software encode
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-s", `${WIDTH}x${HEIGHT}`,
    "-r", FRAMERATE,
    "-b:v", "2000k",
    "-maxrate", "2000k",
    "-bufsize", "4000k",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-x264opts", "repeat-headers=1",
    "-g", String(parseInt(FRAMERATE, 10) * 2), // GOP = 2 seconds
    // Set PAL 4:3 SAR via video filter to avoid encoder/muxer mismatch
    "-vf", `setsar=12/11`,
    // Audio: AAC
    "-c:a", "aac",
    "-b:a", "128k",
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
// WebSocket server — receives WebM chunks from the Chrome extension
// ---------------------------------------------------------------------------

function startWebSocketServer() {
  const wss = new WebSocketServer({ port: WS_PORT }, () => {
    console.log(`[relay] WebSocket server listening on port ${WS_PORT}`);
  });

  wss.on("connection", (socket) => {
    console.log("[relay] extension connected");

    socket.on("message", (data, isBinary) => {
      if (isBinary && ffmpegReady && ffmpeg && ffmpeg.stdin.writable) {
        ffmpeg.stdin.write(Buffer.from(data));
      }
    });

    socket.on("close", () => {
      console.log("[relay] extension disconnected");
    });

    socket.on("error", (err) => {
      console.error("[relay] WebSocket error:", err.message);
    });
  });
}

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

outputHandler = createOutputHandler(OUTPUT);
startFFmpeg();
startWebSocketServer();
