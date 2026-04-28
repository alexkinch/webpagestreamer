// Capture flow:
//   chrome.tabCapture → MediaStream (audio + video tracks)
//   MediaStreamTrackProcessor(video) → VideoFrame stream → I420 bytes → WS /ingest/video
//   MediaStreamTrackProcessor(audio) → AudioData stream → f32le bytes → WS /ingest/audio
//
// Wire protocol (per-message, no inner framing):
//   video: width*height*3/2 bytes, planes Y U V concatenated (I420)
//   audio: variable-length f32le interleaved stereo at 44.1 kHz

(function () {
  let stream = null;
  let videoSession = 0;
  let audioSession = 0;

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

  // Open a WebSocket; retry forever on failure with 2s backoff.
  async function openWS(url) {
    while (true) {
      try {
        const ws = await new Promise((res, rej) => {
          const s = new WebSocket(url);
          s.binaryType = "arraybuffer";
          s.addEventListener("open", () => res(s), { once: true });
          s.addEventListener("error", (e) => rej(e), { once: true });
        });
        return ws;
      } catch (e) {
        console.warn(`[capture] WS connect to ${url} failed, retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async function packI420(frame) {
    const W = frame.codedWidth, H = frame.codedHeight;
    const ySize = W * H;
    const uvSize = (W / 2) * (H / 2);
    const buf = new Uint8Array(ySize + 2 * uvSize);
    await frame.copyTo(buf, {
      layout: [
        { offset: 0,                 stride: W },
        { offset: ySize,             stride: W / 2 },
        { offset: ySize + uvSize,    stride: W / 2 },
      ],
    });
    return buf.buffer;
  }

  function startVideoSender(ws, framerate) {
    const frameIntervalMs = 1000 / framerate;
    let latestFrame = null;
    let droppedDueToBackpressure = 0;

    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer);
        return;
      }
      if (!latestFrame) return;
      if (ws.bufferedAmount > latestFrame.byteLength * 2) {
        droppedDueToBackpressure++;
        if (droppedDueToBackpressure === 1 || droppedDueToBackpressure % 25 === 0) {
          console.warn(`[capture] WS video backpressure — holding latest frame (count=${droppedDueToBackpressure})`);
        }
        return;
      }
      ws.send(latestFrame);
    }, frameIntervalMs);

    ws.addEventListener("close", () => clearInterval(timer), { once: true });
    return {
      update(frameBuffer) {
        latestFrame = frameBuffer;
      },
      stop() {
        clearInterval(timer);
      },
    };
  }

  // Pump VideoFrames → WS until the WS closes or the track ends.
  // The sender emits exactly FRAMERATE frames/second, duplicating the newest
  // rendered frame as needed. That keeps ffmpeg's rawvideo frame-count clock
  // aligned with wall time instead of browser rendering cadence.
  async function pumpVideo(track, ws, mySession, framerate) {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    const sender = startVideoSender(ws, framerate);
    try {
      while (mySession === videoSession && ws.readyState === WebSocket.OPEN) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        try {
          const ab = await packI420(frame);
          sender.update(ab);
        } finally {
          frame.close();
        }
      }
    } finally {
      sender.stop();
      try { reader.cancel(); } catch (e) {}
    }
  }

  function copyAudioToInterleavedF32(chunk) {
    const frames = chunk.numberOfFrames;
    const channels = chunk.numberOfChannels;
    const interleaved = new Float32Array(frames * channels);

    if (chunk.format && chunk.format.endsWith("-planar")) {
      const planes = [];
      for (let channel = 0; channel < channels; channel++) {
        const plane = new Float32Array(frames);
        chunk.copyTo(plane, { planeIndex: channel });
        planes.push(plane);
      }
      for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < channels; channel++) {
          interleaved[frame * channels + channel] = planes[channel][frame];
        }
      }
    } else {
      chunk.copyTo(interleaved, { planeIndex: 0 });
    }

    return interleaved.buffer;
  }

  async function pumpAudio(track, ws, mySession) {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    try {
      while (mySession === audioSession && ws.readyState === WebSocket.OPEN) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        try {
          ws.send(copyAudioToInterleavedF32(chunk));
        } finally {
          chunk.close();
        }
      }
    } finally {
      try { reader.cancel(); } catch (e) {}
    }
  }

  // (Re)open the video WS and pump until it closes; then loop again.
  async function videoLoop(track, vURL, framerate) {
    while (true) {
      const mySession = ++videoSession;
      const ws = await openWS(vURL);
      console.log("[capture] video WS connected");
      ws.addEventListener("close", () => console.log("[capture] video WS closed — will reconnect"));
      await pumpVideo(track, ws, mySession, framerate);
      // Either the WS closed or the track ended. If track ended, exit.
      if (track.readyState === "ended") {
        console.warn("[capture] video track ended — bailing out of loop");
        return;
      }
      // Small backoff before reconnecting.
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function audioLoop(track, aURL) {
    while (true) {
      const mySession = ++audioSession;
      const ws = await openWS(aURL);
      console.log("[capture] audio WS connected");
      ws.addEventListener("close", () => console.log("[capture] audio WS closed — will reconnect"));
      await pumpAudio(track, ws, mySession);
      if (track.readyState === "ended") {
        console.warn("[capture] audio track ended — bailing out of loop");
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function startCapture({ width, height, framerate, relayHost }) {
    hideScrollbars();
    forceFrames();
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

    console.log(`[capture] starting pumps — ${width}x${height}@${framerate}fps → ws://${relayHost}/ingest/*`);

    videoLoop(vTrack, vURL, framerate).catch((e) => console.error("[capture] videoLoop fatal:", e));
    audioLoop(aTrack, aURL).catch((e) => console.error("[capture] audioLoop fatal:", e));
  }

  // The trigger-capture.sh script posts CAPTURE_COMMAND with at minimum:
  //   { type: 'CAPTURE_COMMAND', command: 'start', width, height, framerate }
  // and either `relayHost` (preferred new shape, "host:port") or `port`
  // (legacy shape from the MediaRecorder era — we accept both for now).
  window.addEventListener("message", (event) => {
    if (
      event.data &&
      event.data.type === "CAPTURE_COMMAND" &&
      event.data.command === "start"
    ) {
      const width = event.data.width || 720;
      const height = event.data.height || 576;
      const framerate = event.data.framerate || 25;
      const relayHost =
        event.data.relayHost ||
        (event.data.port ? `127.0.0.1:${event.data.port}` : "127.0.0.1:9000");
      startCapture({ width, height, framerate, relayHost });
    }
  });
})();
