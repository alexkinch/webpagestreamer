#!/bin/bash
# Entrypoint script: writes per-run config and launches supervisord.

set -euo pipefail

URL="${URL:-https://www.google.com}"
WIDTH="${WIDTH:-720}"
HEIGHT="${HEIGHT:-576}"
FRAMERATE="${FRAMERATE:-25}"
OUTPUT="${OUTPUT:-udp://239.0.0.1:1234}"
WS_PORT="${WS_PORT:-9000}"
CDP_PORT="${CDP_PORT:-9222}"
CHANNEL_NAME="${CHANNEL_NAME:-WebPageStreamer}"
CHANNEL_ID="${CHANNEL_ID:-webpagestreamer.1}"
PROGRAMME_TITLE="${PROGRAMME_TITLE:-Live Stream}"
PROGRAMME_DESC="${PROGRAMME_DESC:-}"
STREAM_URL="${STREAM_URL:-}"

EXTENSION_ID="akfimkeaknlnblgelnlelcgihcmconnb"
EXTENSION_DIR="/app/extension"

export URL WIDTH HEIGHT FRAMERATE OUTPUT WS_PORT CDP_PORT
export CHANNEL_NAME CHANNEL_ID PROGRAMME_TITLE PROGRAMME_DESC STREAM_URL

echo "[start] URL=$URL"
echo "[start] Resolution=${WIDTH}x${HEIGHT} @ ${FRAMERATE}fps"
echo "[start] Output=$OUTPUT"

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
