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

WORKDIR /app/relay

# Copy relay server and install deps
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev
COPY relay/ ./

WORKDIR /app

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
    CDP_PORT="9222"

ENTRYPOINT ["/app/start.sh"]
