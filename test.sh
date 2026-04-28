#!/bin/bash
# Quick test script: builds the container, streams a page over TCP,
# and opens it in ffplay/VLC so you can verify the output.

set -euo pipefail

IMAGE="webpagestreamer"
PORT="${PORT:-9876}"
URL="${URL:-https://www.bbc.co.uk}"
DURATION="${DURATION:-30}"

echo "Building $IMAGE..."
docker build -t "$IMAGE" .

echo ""
echo "Starting container — streaming $URL over TCP on port $PORT"
echo "Will run for ${DURATION}s then stop automatically."
echo ""

# Start container in background
CONTAINER_ID=$(docker run -d --rm -p "${PORT}:${PORT}" \
  -e URL="$URL" \
  -e OUTPUT="tcp://0.0.0.0:${PORT}?listen=1" \
  "$IMAGE")

echo "Container: $CONTAINER_ID"
echo "Waiting for container to initialise..."
sleep 5

# Show container logs in background
docker logs -f "$CONTAINER_ID" 2>&1 | sed 's/^/  [container] /' &
LOGS_PID=$!

echo ""
echo "================================================"
echo "  Stream available at: tcp://127.0.0.1:${PORT}"
echo ""
echo "  Open in another terminal with:"
echo "    ffplay -f mpegts tcp://127.0.0.1:${PORT}"
echo "    vlc tcp://127.0.0.1:${PORT}"
echo ""
echo "  Or to save a clip:"
echo "    ffmpeg -f mpegts -i tcp://127.0.0.1:${PORT} -t 10 -c copy test.ts"
echo "================================================"
echo ""

# Wait for specified duration then clean up
echo "Press Ctrl+C to stop early, or waiting ${DURATION}s..."
trap 'echo ""; echo "Stopping..."; kill $LOGS_PID 2>/dev/null; docker stop "$CONTAINER_ID" 2>/dev/null; exit 0' INT TERM

sleep "$DURATION"

echo ""
echo "Test duration complete. Stopping container..."
kill $LOGS_PID 2>/dev/null
docker stop "$CONTAINER_ID" 2>/dev/null

echo "Done."
