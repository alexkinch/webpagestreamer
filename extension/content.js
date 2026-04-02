// Content script: captures tab audio+video via tabCapture stream ID
// and sends WebM chunks over WebSocket to the local relay server.

(function () {
  let recorder = null;
  let ws = null;

  // Hide scrollbars — the captured page should fill the viewport cleanly.
  function hideScrollbars() {
    const style = document.createElement("style");
    style.textContent = `
      html, body { overflow: hidden !important; }
      ::-webkit-scrollbar { display: none !important; }
      video::-webkit-media-controls { display: none !important; }
      video::-webkit-media-controls-overlay-play-button { display: none !important; }
      video::-webkit-media-controls-enclosure { display: none !important; }
      video::-internal-media-controls-overlay-cast-button { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  // Force Chrome to keep rendering frames even on static pages
  // by continuously animating a tiny invisible element.
  function forceFrames() {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:2147483647;";
    document.documentElement.appendChild(el);
    let toggle = false;
    function tick() {
      toggle = !toggle;
      el.style.opacity = toggle ? "0.01" : "0.02";
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function startCapture(port, width, height, framerate) {
    console.log("[capture] requesting stream ID from background...");
    chrome.runtime.sendMessage({ command: "get-stream-id" }, (response) => {
      if (!response || response.error) {
        console.error("[capture] failed to get stream ID:", response);
        // Retry after a delay
        setTimeout(() => startCapture(port, width, height, framerate), 2000);
        return;
      }

      const streamId = response.streamId;
      console.log("[capture] got stream ID, calling getUserMedia...");

      const constraints = {
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
            minFrameRate: framerate,
            maxFrameRate: framerate,
            minWidth: width,
            maxWidth: width,
            minHeight: height,
            maxHeight: height,
          },
        },
      };

      navigator.mediaDevices
        .getUserMedia(constraints)
        .then((stream) => {
          console.log("[capture] got media stream, connecting WebSocket...");
          connectAndRecord(stream, port);
        })
        .catch((err) => {
          console.error("[capture] getUserMedia failed:", err);
          setTimeout(() => startCapture(port, width, height, framerate), 2000);
        });
    });
  }

  function connectAndRecord(stream, port) {
    ws = new WebSocket("ws://127.0.0.1:" + port);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      console.log("[capture] WebSocket connected, starting MediaRecorder...");

      // Use webm with vp8+opus — well supported and FFmpeg can demux it
      const mimeType = "video/webm;codecs=vp8,opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        console.warn("[capture] vp8/opus not supported, falling back...");
      }

      recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported(mimeType)
          ? mimeType
          : "video/webm",
        videoBitsPerSecond: 2500000,
        audioBitsPerSecond: 128000,
      });

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          event.data.arrayBuffer().then((buffer) => {
            ws.send(buffer);
          });
        }
      };

      recorder.onerror = (err) => {
        console.error("[capture] MediaRecorder error:", err);
      };

      // 20ms timeslice for low latency
      recorder.start(20);
      console.log("[capture] MediaRecorder started (20ms timeslice)");
    };

    ws.onclose = () => {
      console.log("[capture] WebSocket closed, stopping recorder...");
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      // Reconnect after a delay
      setTimeout(() => connectAndRecord(stream, port), 2000);
    };

    ws.onerror = (err) => {
      console.error("[capture] WebSocket error:", err);
    };
  }

  // Listen for the start command posted by the startup script via CDP
  window.addEventListener("message", (event) => {
    if (
      event.data &&
      event.data.type === "CAPTURE_COMMAND" &&
      event.data.command === "start"
    ) {
      const port = event.data.port || 9000;
      const width = event.data.width || 720;
      const height = event.data.height || 576;
      const framerate = event.data.framerate || 25;
      console.log(
        "[capture] start command received — port:",
        port,
        "resolution:",
        width + "x" + height,
        "@" + framerate + "fps"
      );
      hideScrollbars();
      forceFrames();
      startCapture(port, width, height, framerate);
    }
  });
})();
