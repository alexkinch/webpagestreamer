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
