#!/usr/bin/env bash
# End-to-end test of WebDAV file shares against real binaries.
#
# Starts a target agent (file transfer on, folder allowed), a gateway agent
# that holds the management signing key and dials the target over QUIC, and
# Muti Metroo Manager pointed at the gateway. It then creates shares through
# the Manager API and checks WebDAV behavior with curl. When available, it
# also runs the litmus WebDAV compliance suite and mounts the share with
# davfs2 (Linux, root) to exercise a real OS client.
#
# Usage:
#   scripts/e2e-fileshare.sh [--bin DIR] [--mm-src DIR]
#
#   --bin DIR     use prebuilt muti-metroo and muti-metroo-manager from DIR
#   --mm-src DIR  Muti Metroo agent checkout to build from (default ../Muti-Metroo)
#
# scripts/e2e-fileshare-docker.sh runs this inside a Linux container with
# litmus and davfs2 installed.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BIN=""
MM_SRC="$REPO/../Muti-Metroo"

while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN="$2"; shift 2 ;;
    --mm-src) MM_SRC="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fileshare-e2e.XXXXXX")"
PIDS=()
MOUNTED=""
cleanup() {
  [ -n "$MOUNTED" ] && umount "$MOUNTED" 2>/dev/null || true
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "${KEEP_WORK:-}" = "1" ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

if [ -z "$BIN" ]; then
  BIN="$WORK/bin"
  mkdir -p "$BIN"
  echo "building muti-metroo from $MM_SRC"
  (cd "$MM_SRC" && go build -o "$BIN/muti-metroo" ./cmd/muti-metroo)
  echo "building muti-metroo-manager (needs a built frontend in internal/webui/dist)"
  (cd "$REPO" && go build -o "$BIN/muti-metroo-manager" ./cmd/manager)
fi
MM="$BIN/muti-metroo"
MGR="$BIN/muti-metroo-manager"

FAILS=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILS=$((FAILS + 1)); }
# check NAME EXPECTED ACTUAL
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (want '$2', got '$3')"; fi; }
# check_in NAME ACTUAL ALLOWED... : ACTUAL is one of ALLOWED
check_in() {
  local name="$1" got="$2"; shift 2
  for want in "$@"; do [ "$got" = "$want" ] && { pass "$name"; return; }; done
  fail "$name (want one of '$*', got '$got')"
}

port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
wait_for() { for _ in $(seq 1 60); do eval "$1" >/dev/null 2>&1 && return 0; sleep 0.25; done; echo "timed out: $1" >&2; return 1; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

SHARE="$WORK/share"
OUTSIDE="$WORK/outside"
mkdir -p "$SHARE/ro" "$OUTSIDE"
echo "secret" > "$OUTSIDE/secret.txt"
echo "read only content" > "$SHARE/ro/readme.txt"
ln -s "$OUTSIDE" "$SHARE/escape"

QUIC_PORT=$(port); T_HTTP=$(port); G_HTTP=$(port); MGR_PORT=$(port)
"$MM" signing-key generate --out "$WORK/keys" >/dev/null
PUB=$(cat "$WORK/keys/signing-public.key")
PRIV=$(cat "$WORK/keys/signing-private.key")

cat > "$WORK/target.yaml" <<EOF
agent:
  data_dir: "$WORK/data-target"
  display_name: "e2e-target"
listeners:
  - transport: quic
    address: "127.0.0.1:$QUIC_PORT"
file_transfer:
  enabled: true
  allowed_paths:
    - "$SHARE"
management:
  signing_public_key: "$PUB"
http:
  enabled: true
  address: "127.0.0.1:$T_HTTP"
EOF
cat > "$WORK/gateway.yaml" <<EOF
agent:
  data_dir: "$WORK/data-gateway"
  display_name: "e2e-gateway"
peers:
  - id: "auto"
    transport: quic
    address: "127.0.0.1:$QUIC_PORT"
management:
  signing_public_key: "$PUB"
  signing_private_key: "$PRIV"
http:
  enabled: true
  address: "127.0.0.1:$G_HTTP"
EOF

"$MM" run -c "$WORK/target.yaml" > "$WORK/target.log" 2>&1 & PIDS+=($!)
wait_for "curl -sf http://127.0.0.1:$T_HTTP/healthz"
"$MM" run -c "$WORK/gateway.yaml" > "$WORK/gateway.log" 2>&1 & PIDS+=($!)
wait_for "curl -s http://127.0.0.1:$G_HTTP/healthz | grep -q '\"peer_count\":1'"
TARGET_ID=$(curl -s "http://127.0.0.1:$T_HTTP/api/dashboard" | python3 -c 'import sys,json; print(json.load(sys.stdin)["agent"]["id"])')
# Wait until the gateway can route management requests to the target.
wait_for "curl -sf -X POST http://127.0.0.1:$G_HTTP/agents/$TARGET_ID/file/browse -d '{\"action\":\"roots\"}'"

TOKEN=$(openssl rand -hex 16)
echo "$TOKEN" > "$WORK/mgr-token"
"$MGR" -addr "127.0.0.1:$MGR_PORT" -agent "http://127.0.0.1:$G_HTTP" -auth-token-file "$WORK/mgr-token" \
  -data-dir "$WORK/mgr" > "$WORK/manager.log" 2>&1 & PIDS+=($!)
wait_for "curl -sf http://127.0.0.1:$MGR_PORT/healthz"
API="http://127.0.0.1:$MGR_PORT/api"
AUTH=(-H "Authorization: Bearer $TOKEN")

create_share() { # name path read_only
  curl -s "${AUTH[@]}" -X POST "$API/shares" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"agent_id\":\"$TARGET_ID\",\"remote_path\":\"$2\",\"read_only\":$3}"
}
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

echo "== share API"
check "create without token is refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/shares" -d '{}')"
RW=$(create_share rw "$SHARE" false)
RW_ID=$(echo "$RW" | json 'd["share"]["id"]'); RW_PW=$(echo "$RW" | json 'd["password"]')
RO=$(create_share ro "$SHARE/ro" true)
RO_PW=$(echo "$RO" | json 'd["password"]')
DUP=$(curl -s -w ' %{http_code}' "${AUTH[@]}" -X POST "$API/shares" -H 'Content-Type: application/json' -d "{\"name\":\"rw\",\"agent_id\":\"$TARGET_ID\",\"remote_path\":\"$SHARE\"}")
check "duplicate name is refused ($DUP)" 409 "${DUP##* }"
check_in "share outside allowed_paths is refused" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "$API/shares" -H 'Content-Type: application/json' -d "{\"name\":\"bad\",\"agent_id\":\"$TARGET_ID\",\"remote_path\":\"$OUTSIDE\"}")" 400 403 502
check "list does not expose password hashes" 0 "$(curl -s "${AUTH[@]}" "$API/shares" | grep -c -i 'hash' || true)"

B="http://127.0.0.1:$MGR_PORT/dav/rw"
U=(-u "rw:$RW_PW")
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== authentication"
check "no credentials" 401 "$(code -X PROPFIND "$B/")"
check "wrong password" 401 "$(code -u rw:wrong-password -X PROPFIND "$B/")"
check "other share's password" 401 "$(code -u "rw:$RO_PW" -X PROPFIND "$B/")"
check "manager token does not open /dav" 401 "$(code "${AUTH[@]}" -X PROPFIND "$B/")"
check "share credentials do not open /api" 401 "$(code "${U[@]}" "$API/shares")"
check "unknown share" 404 "$(code "${U[@]}" -X PROPFIND "http://127.0.0.1:$MGR_PORT/dav/nope/")"
check "options" 200 "$(code "${U[@]}" -X OPTIONS "$B/")"

echo "== read-write share"
check "PROPFIND depth 1" 207 "$(code "${U[@]}" -X PROPFIND -H 'Depth: 1' "$B/")"
check "PROPFIND depth infinity refused" 403 "$(code "${U[@]}" -X PROPFIND -H 'Depth: infinity' "$B/")"
check "MKCOL" 201 "$(code "${U[@]}" -X MKCOL "$B/dir/")"
check "MKCOL existing" 405 "$(code "${U[@]}" -X MKCOL "$B/dir/")"
check "MKCOL missing parent" 409 "$(code "${U[@]}" -X MKCOL "$B/missing/child/")"
printf 'hello webdav\n' > "$WORK/small.txt"
check "PUT" 201 "$(code "${U[@]}" -T "$WORK/small.txt" "$B/dir/small.txt")"
check_in "PUT overwrite" "$(code "${U[@]}" -T "$WORK/small.txt" "$B/dir/small.txt")" 201 204
check "PUT empty file" 201 "$(code "${U[@]}" -X PUT --data-binary '' "$B/dir/empty.txt")"
check "empty file on agent" 0 "$(wc -c < "$SHARE/dir/empty.txt" | tr -d ' ')"
check "GET" "hello webdav" "$(curl -s "${U[@]}" "$B/dir/small.txt")"
check "HEAD length" "13" "$(curl -sI "${U[@]}" "$B/dir/small.txt" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{print $2}')"
check "Range" "webdav" "$(curl -s "${U[@]}" -H 'Range: bytes=6-11' "$B/dir/small.txt")"
check "Range status" 206 "$(code "${U[@]}" -H 'Range: bytes=6-11' "$B/dir/small.txt")"
check "GET missing" 404 "$(code "${U[@]}" "$B/dir/nope.txt")"
check "served with sandbox CSP" 1 "$(curl -sI "${U[@]}" "$B/dir/small.txt" | grep -ci 'content-security-policy: sandbox' || true)"
echo "finder" > "$SHARE/.DS_Store"
check_in "PUT macOS metadata is accepted" "$(code "${U[@]}" -T "$WORK/small.txt" "$B/dir/._small.txt")" 201 204
[ ! -e "$SHARE/dir/._small.txt" ] && pass "macOS metadata not stored on agent" || fail "macOS metadata not stored on agent"
check "macOS metadata reads as missing" 404 "$(code "${U[@]}" "$B/.DS_Store")"
check "macOS metadata left out of listings" 0 "$(curl -s "${U[@]}" -X PROPFIND -H 'Depth: 1' "$B/" | grep -c 'DS_Store' || true)"

dd if=/dev/urandom of="$WORK/big.bin" bs=1048576 count=20 2>/dev/null
check "PUT 20 MiB" 201 "$(code "${U[@]}" -T "$WORK/big.bin" "$B/big.bin")"
curl -s "${U[@]}" "$B/big.bin" -o "$WORK/big.out"
check "20 MiB round trip" "$(sha "$WORK/big.bin")" "$(sha "$WORK/big.out")"
check "20 MiB on agent" "$(sha "$WORK/big.bin")" "$(sha "$SHARE/big.bin")"
dd if="$WORK/big.bin" of="$WORK/slice.want" bs=1 skip=15000000 count=4096 2>/dev/null
curl -s "${U[@]}" -H 'Range: bytes=15000000-15004095' "$B/big.bin" -o "$WORK/slice.got"
check "Range deep in large file" "$(sha "$WORK/slice.want")" "$(sha "$WORK/slice.got")"

check "COPY file" 201 "$(code "${U[@]}" -X COPY -H "Destination: $B/dir/copy.txt" "$B/dir/small.txt")"
check "COPY collection" 201 "$(code "${U[@]}" -X COPY -H 'Depth: infinity' -H "Destination: $B/dir2/" "$B/dir/")"
check "copied collection content" "hello webdav" "$(cat "$SHARE/dir2/small.txt")"
check "MOVE without overwrite onto existing" 412 "$(code "${U[@]}" -X MOVE -H 'Overwrite: F' -H "Destination: $B/dir/copy.txt" "$B/dir/empty.txt")"
check "MOVE with overwrite" 204 "$(code "${U[@]}" -X MOVE -H 'Overwrite: T' -H "Destination: $B/dir/copy.txt" "$B/dir/empty.txt")"
check "MOVE collection" 201 "$(code "${U[@]}" -X MOVE -H "Destination: $B/moved/" "$B/dir2/")"
[ -f "$SHARE/moved/small.txt" ] && [ ! -e "$SHARE/dir2" ] && pass "moved collection on agent" || fail "moved collection on agent"
check_in "MOVE to another share is refused" "$(code "${U[@]}" -X MOVE -H "Destination: http://127.0.0.1:$MGR_PORT/dav/ro/x.txt" "$B/dir/copy.txt")" 404 502
check "DELETE file" 204 "$(code "${U[@]}" -X DELETE "$B/dir/copy.txt")"
check "DELETE collection" 204 "$(code "${U[@]}" -X DELETE "$B/moved/")"
[ ! -e "$SHARE/moved" ] && pass "deleted collection on agent" || fail "deleted collection on agent"
LOCK_BODY='<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>'
check_in "LOCK" "$(code "${U[@]}" -X LOCK -H 'Content-Type: application/xml' --data "$LOCK_BODY" "$B/dir/lockme.txt")" 200 201
check "PUT to locked file without token" 423 "$(code "${U[@]}" -T "$WORK/small.txt" "$B/dir/lockme.txt")"

echo "== confinement"
check_in "encoded .. stays in share" "$(code "${U[@]}" --path-as-is "$B/%2e%2e/%2e%2e/outside/secret.txt")" 400 403 404
check_in "symlink out of allowed_paths" "$(code "${U[@]}" "$B/escape/secret.txt")" 403 404
check_in "MOVE into symlinked dir" "$(code "${U[@]}" -X MOVE -H "Destination: $B/escape/stolen.txt" "$B/dir/small.txt")" 403 404 409 502
[ ! -e "$OUTSIDE/stolen.txt" ] && [ -f "$SHARE/dir/small.txt" ] && pass "nothing written outside" || fail "nothing written outside"

RB="http://127.0.0.1:$MGR_PORT/dav/ro"
RU=(-u "ro:$RO_PW")
echo "== read-only share"
check "GET" "read only content" "$(curl -s "${RU[@]}" "$RB/readme.txt")"
check "PUT refused" 403 "$(code "${RU[@]}" -T "$WORK/small.txt" "$RB/new.txt")"
check "DELETE refused" 403 "$(code "${RU[@]}" -X DELETE "$RB/readme.txt")"
check "MKCOL refused" 403 "$(code "${RU[@]}" -X MKCOL "$RB/d/")"
check "MOVE refused" 403 "$(code "${RU[@]}" -X MOVE -H "Destination: $RB/x.txt" "$RB/readme.txt")"
check "PROPPATCH refused" 403 "$(code "${RU[@]}" -X PROPPATCH "$RB/readme.txt")"
check "LOCK refused" 403 "$(code "${RU[@]}" -X LOCK -H 'Content-Type: application/xml' --data "$LOCK_BODY" "$RB/readme.txt")"
[ -f "$SHARE/ro/readme.txt" ] && [ ! -e "$SHARE/ro/new.txt" ] && pass "read-only share unchanged on agent" || fail "read-only share unchanged on agent"

echo "== share lifecycle"
patch() { curl -s "${AUTH[@]}" -X PATCH "$API/shares/$RW_ID" -H 'Content-Type: application/json' -d "$1"; }
patch '{"enabled":false}' >/dev/null
check "disabled share" 404 "$(code "${U[@]}" -X PROPFIND "$B/")"
patch '{"enabled":true}' >/dev/null
check "re-enabled share" 207 "$(code "${U[@]}" -X PROPFIND "$B/")"
NEW_PW=$(patch '{"rotate_password":true}' | json 'd["password"]')
check "old password after rotation" 401 "$(code "${U[@]}" -X PROPFIND "$B/")"
check "new password after rotation" 207 "$(code -u "rw:$NEW_PW" -X PROPFIND "$B/")"
U=(-u "rw:$NEW_PW")

if command -v litmus >/dev/null; then
  echo "== litmus WebDAV compliance"
  # basic, copymove, and http must pass. In locks, only failures caused by
  # golang.org/x/net/webdav limits are accepted: no shared locks
  # (lock_shared), no evaluation of complex If-header conditions
  # (fail_complex_cond_put), and no stored dead properties, which the
  # owner_modify PROPPATCH needs. Any other locks failure fails the run.
  if (cd "$WORK" && TESTS="basic copymove http" litmus "$B/" rw "$NEW_PW") > "$WORK/litmus.log" 2>&1; then
    pass "litmus basic copymove http"
  else
    fail "litmus basic copymove http (see below)"; grep -E 'FAIL|WARNING|summary' "$WORK/litmus.log" || true
  fi
  (cd "$WORK" && TESTS="locks" litmus "$B/" rw "$NEW_PW") > "$WORK/litmus-locks.log" 2>&1 || true
  UNEXPECTED=$(grep -oE '[0-9]+\. [a-z_]+\.+ FAIL' "$WORK/litmus-locks.log" | awk '{print $2}' | tr -d '.' \
    | grep -v -x -E 'lock_shared|fail_complex_cond_put|owner_modify' || true)
  if grep -q 'summary for .locks' "$WORK/litmus-locks.log" && [ -z "$UNEXPECTED" ]; then
    pass "litmus locks (only known library limits fail)"
  else
    fail "litmus locks: unexpected failures: ${UNEXPECTED:-run did not complete}"; grep -E 'FAIL|summary' "$WORK/litmus-locks.log" || true
  fi
else
  echo "== litmus not installed, skipped"
fi

if command -v mount.davfs >/dev/null && [ "$(id -u)" = 0 ]; then
  echo "== davfs2 mount"
  MNT="$WORK/mnt"; mkdir -p "$MNT"
  echo "$B/ rw $NEW_PW" >> /etc/davfs2/secrets
  if mount -t davfs "$B/" "$MNT" -o uid=0,gid=0 >/dev/null 2>&1 </dev/null; then
    MOUNTED="$MNT"
    [ -f "$MNT/dir/small.txt" ] && pass "listing" || fail "listing"
    check "read through mount" "hello webdav" "$(cat "$MNT/dir/small.txt")"
    cp "$WORK/big.bin" "$MNT/fromdavfs.bin" && mkdir "$MNT/davdir" && echo hi > "$MNT/davdir/a.txt" && mv "$MNT/davdir/a.txt" "$MNT/davdir/b.txt" && rm "$MNT/dir/small.txt"
    sync; umount "$MNT"; MOUNTED=""
    check "davfs write on agent" "$(sha "$WORK/big.bin")" "$(sha "$SHARE/fromdavfs.bin")"
    check "davfs rename on agent" "hi" "$(cat "$SHARE/davdir/b.txt" 2>/dev/null)"
    [ ! -e "$SHARE/dir/small.txt" ] && pass "davfs delete on agent" || fail "davfs delete on agent"
  else
    fail "davfs mount"
  fi
else
  echo "== davfs2 not available (needs mount.davfs and root), skipped"
fi

echo
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed. Logs: target.log gateway.log manager.log (KEEP_WORK=1 keeps $WORK)"
  exit 1
fi
echo "all checks passed"
