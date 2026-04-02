FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies: Chromium, FFmpeg, Node.js, supervisor, Python/websockets
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    supervisor \
    curl \
    ca-certificates \
    gnupg \
    python3 \
    python3-pip \
    python3-websockets \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

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
    OUTPUT="udp://239.0.0.1:1234?pkt_size=1316" \
    WIDTH="720" \
    HEIGHT="576" \
    FRAMERATE="25" \
    WS_PORT="9000" \
    CDP_PORT="9222"

ENTRYPOINT ["/app/start.sh"]
