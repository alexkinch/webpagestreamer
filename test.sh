#!/bin/bash
# Quick smoke test: build the container, stream via HTTP progressive,
# and show a URL that ffplay/VLC can open.

set -euo pipefail

IMAGE="webpagestreamer"
PORT="${PORT:-9000}"
URL="${URL:-http://127.0.0.1:${PORT}/test/clock.html}"
DURATION="${DURATION:-60}"

echo "Building $IMAGE..."
docker build -t "$IMAGE" .

echo ""
echo "Starting container — capturing $URL, serving MPEG-TS over HTTP on :$PORT"
echo "Will run for ${DURATION}s then stop automatically."
echo ""

CONTAINER_ID=$(docker run -d --rm -p "${PORT}:${PORT}" \
  -e URL="$URL" \
  -e HTTP_OUTPUT=true \
  -e UDP_OUTPUT="" \
  -e HTTP_PORT="$PORT" \
  "$IMAGE")

echo "Container: $CONTAINER_ID"
echo "Waiting for container to initialise..."
sleep 5

docker logs -f "$CONTAINER_ID" 2>&1 | sed 's/^/  [container] /' &
LOGS_PID=$!

echo ""
echo "================================================"
echo "  Stream available at: http://127.0.0.1:${PORT}/stream.ts"
echo ""
echo "  Open in another terminal with:"
echo "    ffplay -f mpegts http://127.0.0.1:${PORT}/stream.ts"
echo "    vlc http://127.0.0.1:${PORT}/stream.ts"
echo ""
echo "  Health check: curl http://127.0.0.1:${PORT}/health"
echo ""
echo "  To save a clip:"
echo "    ffmpeg -i http://127.0.0.1:${PORT}/stream.ts -t 10 -c copy test.ts"
echo "================================================"
echo ""

trap 'echo ""; echo "Stopping..."; kill $LOGS_PID 2>/dev/null; docker stop "$CONTAINER_ID" 2>/dev/null; exit 0' INT TERM

sleep "$DURATION"

echo ""
echo "Test duration complete. Stopping container..."
kill $LOGS_PID 2>/dev/null
docker stop "$CONTAINER_ID" 2>/dev/null

echo "Done."
