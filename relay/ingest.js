// Wire protocol:
//   ws://host:PORT/ingest/video?w=<W>&h=<H>&fr=<FR>
//     each binary message = one raw I420 frame (W*H*3/2 bytes), planes Y U V
//   ws://host:PORT/ingest/audio?sr=<SR>&ch=<CH>
//     each binary message = raw f32le interleaved PCM, variable length
//
// Both connections must validate against `expected` (set by the relay from
// the resolved profile); mismatched params are rejected at handshake.

const { WebSocketServer } = require("ws");

const WS_OPEN = 1;
const backpressureLogTimes = new Map();

function logBackpressure(label) {
  const now = Date.now();
  const last = backpressureLogTimes.get(label) || 0;
  if (now - last < 1000) return;
  backpressureLogTimes.set(label, now);
  console.log(`[ingest] paused ${label} websocket for sink backpressure`);
}

function writeWithBackpressure(ws, sink, data, label) {
  const ok = sink.write(data);
  if (ok !== false || !ws._socket || ws._socket.isPaused() || typeof sink.once !== "function") return;

  ws._socket.pause();
  sink.once("drain", () => {
    if (ws.readyState === WS_OPEN && ws._socket) {
      ws._socket.resume();
    }
  });
  logBackpressure(label);
}

function mountIngest(httpServer, { videoSink, audioSink, expected, onVideoConnect, onAudioConnect }) {
  const wssVideo = new WebSocketServer({ noServer: true });
  const wssAudio = new WebSocketServer({ noServer: true });

  wssVideo.on("connection", (ws) => {
    console.log("[ingest] video client connected");
    if (onVideoConnect) onVideoConnect(true);
    ws.on("message", (data) => writeWithBackpressure(ws, videoSink, data, "video"));
    ws.on("close", () => {
      console.log("[ingest] video client disconnected");
      if (onVideoConnect) onVideoConnect(false);
    });
    ws.on("error", (e) => console.warn("[ingest] video error:", e.message));
  });

  wssAudio.on("connection", (ws) => {
    console.log("[ingest] audio client connected");
    if (onAudioConnect) onAudioConnect(true);
    ws.on("message", (data) => writeWithBackpressure(ws, audioSink, data, "audio"));
    ws.on("close", () => {
      console.log("[ingest] audio client disconnected");
      if (onAudioConnect) onAudioConnect(false);
    });
    ws.on("error", (e) => console.warn("[ingest] audio error:", e.message));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, "ws://127.0.0.1");
    if (pathname === "/ingest/video") {
      const w = parseInt(searchParams.get("w"), 10);
      const h = parseInt(searchParams.get("h"), 10);
      const fr = parseFloat(searchParams.get("fr"));
      if (w !== expected.width || h !== expected.height || fr !== expected.framerate) {
        console.warn(`[ingest] rejecting video upgrade: got ${w}x${h}@${fr} expected ${expected.width}x${expected.height}@${expected.framerate}`);
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy();
        return;
      }
      wssVideo.handleUpgrade(req, socket, head, (ws) => wssVideo.emit("connection", ws, req));
      return;
    }
    if (pathname === "/ingest/audio") {
      const sr = parseInt(searchParams.get("sr"), 10);
      const ch = parseInt(searchParams.get("ch"), 10);
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
