#!/usr/bin/env bash
set -euo pipefail

# Runs the ImapFlow live integration tests against Apache James (the in-memory
# server distribution in Docker). Opt-in via `npm run test:james` - not part of
# the regular `npm test` run, which stays Docker-free.
#
# Environment overrides:
#   IMAPFLOW_JAMES_IMAGE     image to run (default apache/james:memory-3.9.1)
#   IMAPFLOW_JAMES_PLATFORM  defaults to linux/amd64, the only platform the
#                            apache/james images are published for (runs under
#                            Rosetta/QEMU emulation on arm64 hosts)
#   IMAPFLOW_JAMES_PORT      host port for IMAP (default 31144)
#   IMAPFLOW_JAMES_WEBADMIN_PORT  host port for the WebAdmin API (default 31180)

CONTAINER_NAME="${IMAPFLOW_JAMES_CONTAINER:-imapflow-james-test}"
IMAGE="${IMAPFLOW_JAMES_IMAGE:-apache/james:memory-3.9.1}"
PLATFORM="${IMAPFLOW_JAMES_PLATFORM:-linux/amd64}"
PORT="${IMAPFLOW_JAMES_PORT:-31144}"
WEBADMIN_PORT="${IMAPFLOW_JAMES_WEBADMIN_PORT:-31180}"
WEBADMIN_PASSWORD="imapflow-test"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run --platform="$PLATFORM" -d --name "$CONTAINER_NAME" \
    -e JAMES_WEBADMIN_PASSWORD="$WEBADMIN_PASSWORD" \
    -v "$SCRIPT_DIR/james/start-james.sh:/start-james.sh:ro" \
    --entrypoint /start-james.sh \
    -p "127.0.0.1:$PORT:143" \
    -p "127.0.0.1:$WEBADMIN_PORT:8000" \
    "$IMAGE" >/dev/null

# James accepts connections on the IMAP port a moment before it has finished
# starting, so readiness is its own log line rather than the greeting
echo "Waiting for Apache James to start..."
for i in $(seq 1 120); do
    if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "JAMES server started"; then
        echo "Apache James is ready"
        break
    fi
    if [ "$i" = 120 ] || ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
        echo "Apache James container did not become ready" >&2
        docker logs "$CONTAINER_NAME" >&2 || true
        exit 1
    fi
    sleep 1
done

cd "$PROJECT_DIR"
IMAPFLOW_TEST_HOST=127.0.0.1 IMAPFLOW_TEST_PORT="$PORT" \
    IMAPFLOW_JAMES_WEBADMIN="http://127.0.0.1:$WEBADMIN_PORT" IMAPFLOW_JAMES_WEBADMIN_PASSWORD="$WEBADMIN_PASSWORD" \
    node --import tsx --test --test-force-exit test/integration/james-live-test.ts
