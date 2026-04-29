#!/bin/bash
# Entrypoint script: writes per-run config and launches supervisord.

set -euo pipefail

URL="${URL:-https://www.google.com}"
OUTPUT="${OUTPUT:-udp://239.0.0.1:1234}"
PROFILE="${PROFILE:-pal}"
WS_PORT="${WS_PORT:-9000}"
CDP_PORT="${CDP_PORT:-9222}"
CHANNEL_NAME="${CHANNEL_NAME:-WebPageStreamer}"
CHANNEL_ID="${CHANNEL_ID:-webpagestreamer.1}"
PROGRAMME_TITLE="${PROGRAMME_TITLE:-Live Stream}"
PROGRAMME_DESC="${PROGRAMME_DESC:-}"
STREAM_URL="${STREAM_URL:-}"
INGEST_MODE="${INGEST_MODE:-webm}"
CAPTURE_MODE="${CAPTURE_MODE:-$INGEST_MODE}"

# Resolve WIDTH/HEIGHT/FRAMERATE from profile if not explicitly set
case "$PROFILE" in
  pal)   _W=720;  _H=576;  _F=25    ;;
  ntsc)  _W=720;  _H=480;  _F=29.97 ;;
  720p)  _W=1280; _H=720;  _F=30    ;;
  1080p) _W=1920; _H=1080; _F=30    ;;
  hls)   _W=1280; _H=720;  _F=30    ;;
  *)     _W=720;  _H=576;  _F=25    ;;
esac
WIDTH="${WIDTH:-$_W}"
HEIGHT="${HEIGHT:-$_H}"
if [ -z "${FRAMERATE+x}" ]; then
    if [ "$INGEST_MODE" = "webm" ]; then
        # Chrome's MediaRecorder/tabCapture path commonly emits 60fps WebM even
        # when lower frame-rate constraints are requested. Match that clock by
        # default in WebM mode; raw mode keeps the profile's broadcast rate.
        FRAMERATE=60
    else
        FRAMERATE="$_F"
    fi
fi

EXTENSION_ID="akfimkeaknlnblgelnlelcgihcmconnb"
EXTENSION_DIR="/app/extension"

export URL WIDTH HEIGHT FRAMERATE OUTPUT PROFILE WS_PORT CDP_PORT
export CHANNEL_NAME CHANNEL_ID PROGRAMME_TITLE PROGRAMME_DESC STREAM_URL
export INGEST_MODE CAPTURE_MODE

echo "[start] Profile=$PROFILE"
echo "[start] URL=$URL"
echo "[start] Resolution=${WIDTH}x${HEIGHT} @ ${FRAMERATE}fps"
echo "[start] Output=$OUTPUT"
echo "[start] Ingest=$INGEST_MODE (extension captureMode=$CAPTURE_MODE)"

# Extract the origin from the URL to allow insecure tabCapture on HTTP origins.
# chrome.tabCapture requires HTTPS unless the origin is explicitly allowlisted.
URL_ORIGIN=$(echo "$URL" | sed -E 's|(https?://[^/]+).*|\1|')
UNSAFELY_ALLOW=""
if echo "$URL_ORIGIN" | grep -q "^http://"; then
    UNSAFELY_ALLOW="--unsafely-treat-insecure-origin-as-secure=${URL_ORIGIN}"
    echo "[start] Allowing insecure origin for tabCapture: $URL_ORIGIN"
fi

# Write a Chrome launcher script that supervisord will run
cat > /tmp/launch-chrome.sh <<SCRIPT_END
#!/bin/bash
exec chromium \\
    --headless=new \\
    --no-sandbox \\
    --disable-gpu \\
    --disable-dev-shm-usage \\
    --disable-software-rasterizer \\
    --remote-debugging-port=\${CDP_PORT} \\
    --remote-debugging-address=127.0.0.1 \\
    --load-extension=\${EXTENSION_DIR} \\
    --disable-extensions-except=\${EXTENSION_DIR} \\
    --allowlisted-extension-id=\${EXTENSION_ID} \\
    --auto-accept-this-tab-capture \\
    --autoplay-policy=no-user-gesture-required \\
    --disable-background-timer-throttling \\
    --disable-backgrounding-occluded-windows \\
    --disable-renderer-backgrounding \\
    --disable-features=PictureInPicture,MediaSessionService \\
    --window-size=\${WIDTH},\${HEIGHT} \\
    --user-data-dir=/tmp/chrome-profile \\
    ${UNSAFELY_ALLOW} \\
    "\${URL}"
SCRIPT_END
chmod +x /tmp/launch-chrome.sh

# Export vars needed by the chrome launcher
export EXTENSION_ID EXTENSION_DIR

# Start supervisord (manages relay, chrome, and trigger)
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
