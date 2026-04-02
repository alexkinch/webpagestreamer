// WebSocket relay server: receives WebM chunks from the Chrome extension
// and pipes them into FFmpeg, which encodes to MPEG-TS and outputs to
// the configured destination.

const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const WS_PORT = parseInt(process.env.WS_PORT || "9000", 10);
const OUTPUT = process.env.OUTPUT || "udp://239.0.0.1:1234?pkt_size=1316";
const WIDTH = process.env.WIDTH || "720";
const HEIGHT = process.env.HEIGHT || "576";
const FRAMERATE = process.env.FRAMERATE || "25";

let ffmpeg = null;
let ffmpegReady = false;

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
    "-g", String(parseInt(FRAMERATE, 10) * 2), // GOP = 2 seconds
    // Audio: AAC
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    // Sync and format
    "-vsync", "cfr",
    "-async", "1",
    "-f", "mpegts",
    // Output destination
    OUTPUT,
  ];

  console.log(`[relay] starting FFmpeg: ffmpeg ${args.join(" ")}`);
  ffmpeg = spawn("ffmpeg", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  ffmpegReady = true;

  ffmpeg.stdout.on("data", (data) => {
    // FFmpeg stdout — typically empty for mpegts output to network
  });

  ffmpeg.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line) {
      // Log FFmpeg output but filter excessive frame lines
      if (line.startsWith("frame=") || line.startsWith("size=")) {
        // Only log these occasionally
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

function startWebSocketServer() {
  const wss = new WebSocketServer({ port: WS_PORT });
  console.log(`[relay] WebSocket server listening on port ${WS_PORT}`);

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

// Start both components
startFFmpeg();
startWebSocketServer();

console.log(`[relay] relay server ready — output: ${OUTPUT}`);
