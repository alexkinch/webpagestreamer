#!/bin/bash
# Long-running trigger: waits for Chrome CDP, then on each distinct page
# target it sees (including after a Chrome restart), sends CAPTURE_COMMAND
# so content.js kicks off the WHIP publish. Exits only on unrecoverable
# errors — supervisord will restart it.

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
HTTP_PORT="${HTTP_PORT:-9000}"
WIDTH="${WIDTH:-720}"
HEIGHT="${HEIGHT:-576}"
FRAMERATE="${FRAMERATE:-25}"
WHIP_URL="${WHIP_URL:-http://127.0.0.1:8889/live/whip}"
POLL_INTERVAL="${TRIGGER_POLL_INTERVAL:-5}"

fire_capture() {
    local ws_url="$1"
    python3 <<PYEOF
import json, asyncio, sys, websockets

async def trigger():
    ws_url = "${ws_url}"
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({
            "id": 1,
            "method": "Emulation.setDeviceMetricsOverride",
            "params": {"width": ${WIDTH}, "height": ${HEIGHT}, "deviceScaleFactor": 1, "mobile": False},
        }))
        await ws.recv()
        await ws.send(json.dumps({
            "id": 2,
            "method": "Runtime.evaluate",
            "params": {
                "expression": """
                    window.postMessage({
                        type: 'CAPTURE_COMMAND',
                        command: 'start',
                        whipUrl: '${WHIP_URL}',
                        width: ${WIDTH},
                        height: ${HEIGHT},
                        framerate: ${FRAMERATE}
                    }, '*');
                    'capture triggered';
                """,
                "returnByValue": True,
            },
        }))
        resp = await ws.recv()
        print("[trigger] CDP response:", resp, flush=True)

try:
    asyncio.run(trigger())
except Exception as e:
    print(f"[trigger] fire failed: {e}", file=sys.stderr, flush=True)
    sys.exit(1)
PYEOF
}

get_page_target() {
    # Prints "<target_id> <webSocketDebuggerUrl>" for the first page tab, or empty.
    curl -s "http://127.0.0.1:${CDP_PORT}/json" 2>/dev/null | python3 -c "
import sys, json
try:
    tabs = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for tab in tabs:
    if tab.get('type') == 'page':
        print(tab.get('id', ''), tab.get('webSocketDebuggerUrl', ''))
        break
"
}

echo "[trigger] waiting for Chrome CDP on port $CDP_PORT..."
for i in $(seq 1 60); do
    if curl -s "http://127.0.0.1:${CDP_PORT}/json" > /dev/null 2>&1; then
        echo "[trigger] Chrome CDP is ready"
        break
    fi
    if [ "$i" = "60" ]; then
        echo "[trigger] ERROR: Chrome did not start within 60s"
        exit 1
    fi
    sleep 1
done

# Give the page time to load and content.js to inject.
sleep 3

last_target=""
miss_count=0

while true; do
    page=$(get_page_target || true)
    if [ -z "$page" ]; then
        miss_count=$((miss_count + 1))
        if [ "$miss_count" -ge 12 ]; then
            echo "[trigger] ERROR: CDP unreachable for $((miss_count * POLL_INTERVAL))s — exiting so supervisord can restart us"
            exit 1
        fi
        sleep "$POLL_INTERVAL"
        continue
    fi
    miss_count=0

    target_id=$(echo "$page" | awk '{print $1}')
    ws_url=$(echo "$page" | awk '{print $2}')

    if [ "$target_id" != "$last_target" ]; then
        echo "[trigger] new page target detected ($target_id) — firing CAPTURE_COMMAND"
        if fire_capture "$ws_url"; then
            last_target="$target_id"
        else
            echo "[trigger] fire failed — will retry next poll"
        fi
    fi

    sleep "$POLL_INTERVAL"
done
