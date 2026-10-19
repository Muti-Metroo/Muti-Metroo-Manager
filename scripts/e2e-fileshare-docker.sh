#!/usr/bin/env bash
# Runs scripts/e2e-fileshare.sh inside a Linux container that has the litmus
# WebDAV compliance suite and davfs2 (a kernel-mounted WebDAV client), so the
# file share is exercised by a real OS client as well as by curl.
#
# Builds Linux binaries of the agent (from --mm-src, default ../Muti-Metroo)
# and of Muti Metroo Manager (needs a built frontend in internal/webui/dist;
# run `make build` first). The container runs privileged because davfs2
# mounts through FUSE.
#
# Usage: scripts/e2e-fileshare-docker.sh [--mm-src DIR]

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
MM_SRC="$REPO/../Muti-Metroo"
[ "${1:-}" = "--mm-src" ] && MM_SRC="$2"

ARCH="$(docker version --format '{{.Server.Arch}}')"
BIN="$(mktemp -d "${TMPDIR:-/tmp}/fileshare-e2e-bin.XXXXXX")"
trap 'rm -rf "$BIN"' EXIT

echo "building linux/$ARCH binaries"
(cd "$MM_SRC" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -o "$BIN/muti-metroo" ./cmd/muti-metroo)
(cd "$REPO" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -o "$BIN/muti-metroo-manager" ./cmd/manager)

docker run --rm --privileged --device /dev/fuse \
  -v "$BIN:/e2e/bin:ro" -v "$HERE:/e2e/scripts:ro" \
  debian:bookworm-slim bash -c '
    set -e
    apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl litmus davfs2 procps openssl python3 ca-certificates >/dev/null
    /e2e/scripts/e2e-fileshare.sh --bin /e2e/bin
  '
