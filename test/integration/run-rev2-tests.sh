#!/usr/bin/env bash
set -euo pipefail

# Runs the ImapFlow live integration tests against a real IMAP4rev2 server
# (Dovecot 2.4+ in Docker). Opt-in via `npm run test:rev2` - not part of the
# regular `npm test` run, which stays Docker-free.
#
# Environment overrides:
#   IMAPFLOW_DOVECOT_IMAGE     image to run (default dovecot/dovecot:2.4.4)
#   IMAPFLOW_DOVECOT_PLATFORM  e.g. linux/amd64; defaults to the host platform.
#                              Note: forcing linux/amd64 on Apple Silicon does
#                              not work - Rosetta cannot start Dovecot's
#                              privilege-separated login processes.
#   IMAPFLOW_TEST_PORT         host port to publish (default 31143)

CONTAINER_NAME="${IMAPFLOW_DOVECOT_CONTAINER:-imapflow-rev2-test}"
IMAGE="${IMAPFLOW_DOVECOT_IMAGE:-dovecot/dovecot:2.4.4}"
PORT="${IMAPFLOW_TEST_PORT:-31143}"

# Empty unless a platform override was requested; --platform=value keeps it a
# single argument so plain ${PLATFORM_ARG:+...} expansion works under set -u
PLATFORM_ARG="${IMAPFLOW_DOVECOT_PLATFORM:+--platform=$IMAPFLOW_DOVECOT_PLATFORM}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run ${PLATFORM_ARG:+"$PLATFORM_ARG"} -d --name "$CONTAINER_NAME" \
    -e USER_PASSWORD=pass \
    -v "$SCRIPT_DIR/dovecot-test.conf:/etc/dovecot/conf.d/99-imapflow-test.conf:ro" \
    -p "127.0.0.1:$PORT:31143" \
    "$IMAGE" >/dev/null

echo "Waiting for Dovecot to accept IMAP connections on port $PORT..."
for i in $(seq 1 30); do
    if node -e "
        const net = require('net');
        const socket = net.connect(Number(process.argv[1]), '127.0.0.1');
        const bail = code => { socket.destroy(); process.exit(code); };
        socket.on('data', chunk => bail(chunk.toString().startsWith('* OK') ? 0 : 1));
        socket.on('error', () => bail(1));
        setTimeout(() => bail(1), 2000);
    " "$PORT" 2>/dev/null; then
        echo "Dovecot is ready"
        break
    fi
    if [ "$i" = 30 ]; then
        echo "Dovecot container did not become ready" >&2
        docker logs "$CONTAINER_NAME" >&2 || true
        exit 1
    fi
    sleep 1
done

cd "$PROJECT_DIR"
IMAPFLOW_TEST_HOST=127.0.0.1 IMAPFLOW_TEST_PORT="$PORT" npx nodeunit test/integration/rev2-live-test.js
