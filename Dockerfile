FROM alpine:3.21

# Install dependencies: Chromium, FFmpeg, Node.js, supervisor, Python/websockets
RUN apk add --no-cache \
    chromium \
    ffmpeg \
    nodejs \
    npm \
    supervisor \
    bash \
    curl \
    python3 \
    py3-websockets

WORKDIR /app

# Copy relay server and install deps
COPY relay/ /app/relay/
RUN cd /app/relay && npm install --production

# Copy extension
COPY extension/ /app/extension/

# Copy scripts and config
COPY start.sh /app/start.sh
COPY trigger-capture.sh /app/trigger-capture.sh
COPY supervisord.conf /etc/supervisor/supervisord.conf
RUN chmod +x /app/start.sh /app/trigger-capture.sh

# Environment defaults
ENV URL="https://www.google.com" \
    OUTPUT="udp://239.0.0.1:1234" \
    WIDTH="720" \
    HEIGHT="576" \
    FRAMERATE="25" \
    WS_PORT="9000" \
    CDP_PORT="9222" \
    CHANNEL_NAME="WebPageStreamer" \
    CHANNEL_ID="webpagestreamer.1" \
    PROGRAMME_TITLE="Live Stream" \
    PROGRAMME_DESC="" \
    STREAM_URL=""

ENTRYPOINT ["/app/start.sh"]
