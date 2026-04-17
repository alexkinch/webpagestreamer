#!/bin/bash
# Entrypoint: writes mediamtx config + Chrome launcher, then starts supervisord.

set -euo pipefail

URL="${URL:-https://www.google.com}"
UDP_OUTPUT="${UDP_OUTPUT:-udp://239.0.0.1:1234}"
HTTP_OUTPUT="${HTTP_OUTPUT:-true}"
PROFILE="${PROFILE:-pal}"
# Accept the old WS_PORT as a silent fallback for one release.
HTTP_PORT="${HTTP_PORT:-${WS_PORT:-9000}}"
CDP_PORT="${CDP_PORT:-9222}"
CHANNEL_NAME="${CHANNEL_NAME:-WebPageStreamer}"
CHANNEL_ID="${CHANNEL_ID:-webpagestreamer.1}"
PROGRAMME_TITLE="${PROGRAMME_TITLE:-Live Stream}"
PROGRAMME_DESC="${PROGRAMME_DESC:-}"
STREAM_URL="${STREAM_URL:-}"

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
FRAMERATE="${FRAMERATE:-$_F}"

EXTENSION_ID="akfimkeaknlnblgelnlelcgihcmconnb"
EXTENSION_DIR="/app/extension"

export URL WIDTH HEIGHT FRAMERATE PROFILE
export UDP_OUTPUT HTTP_OUTPUT HTTP_PORT CDP_PORT
export CHANNEL_NAME CHANNEL_ID PROGRAMME_TITLE PROGRAMME_DESC STREAM_URL

echo "[start] Profile=$PROFILE"
echo "[start] URL=$URL"
echo "[start] Resolution=${WIDTH}x${HEIGHT} @ ${FRAMERATE}fps"
echo "[start] UDP_OUTPUT=$UDP_OUTPUT"
echo "[start] HTTP_OUTPUT=$HTTP_OUTPUT"
echo "[start] HTTP_PORT=$HTTP_PORT"

# mediamtx config
cat > /etc/mediamtx.yml <<'MTXEOF'
logLevel: info
logDestinations: [stdout]

rtsp: yes
rtspAddress: 127.0.0.1:8554
webrtc: yes
webrtcAddress: 127.0.0.1:8889
webrtcLocalUDPAddress: 127.0.0.1:8189
webrtcAdditionalHosts: [127.0.0.1]
hls: no
rtmp: no
srt: no
api: no

paths:
  live:
    source: publisher
MTXEOF

# Allow insecure origin for tabCapture if URL is http://
URL_ORIGIN=$(echo "$URL" | sed -E 's|(https?://[^/]+).*|\1|')
UNSAFELY_ALLOW=""
if echo "$URL_ORIGIN" | grep -q "^http://"; then
    UNSAFELY_ALLOW="--unsafely-treat-insecure-origin-as-secure=${URL_ORIGIN}"
    echo "[start] Allowing insecure origin for tabCapture: $URL_ORIGIN"
fi

# Chrome launcher. Waits for the relay HTTP port and mediamtx RTSP port
# to be listening before launching chromium — otherwise Chrome may hit
# the target URL before the relay has bound its socket and bounce to a
# chrome-error:// page that never recovers.
cat > /tmp/launch-chrome.sh <<SCRIPT_END
#!/bin/bash
echo "[chrome] waiting for relay :\${HTTP_PORT} and mediamtx :8554..."
for _ in \$(seq 1 60); do
    if (echo > /dev/tcp/127.0.0.1/\${HTTP_PORT}) 2>/dev/null \\
       && (echo > /dev/tcp/127.0.0.1/8554) 2>/dev/null; then
        echo "[chrome] dependencies ready"
        break
    fi
    sleep 0.5
done
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

export EXTENSION_ID EXTENSION_DIR

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
