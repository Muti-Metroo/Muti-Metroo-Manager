#!/bin/bash
# Build the downloads bundle: a single zip containing Muti Metroo + Mutiauk
# binaries, the Muti Metroo user manual, and a manifest.json describing them.
#
# Inputs (must already be built/released):
#   ../Muti-Metroo/dist/         — produced by Muti-Metroo/release.sh
#   ../Mutiauk/dist/   — produced by Mutiauk/release.sh
#
# Output:
#   dist/muti-metroo-downloads-bundle.zip
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

MUTI_METROO_DIST="../Muti-Metroo/dist"
ENTRY_DIST="../Mutiauk/dist"
MUTI_METROO_VERSION_FILE="../Muti-Metroo/VERSION"
ENTRY_VERSION_FILE="../Mutiauk/VERSION"

OUT_DIR="dist"
OUT_ZIP="$OUT_DIR/muti-metroo-downloads-bundle.zip"

# --- Pre-flight ---
for cmd in zip jq; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: $cmd is required but not found"
        exit 1
    fi
done

if [ ! -d "$MUTI_METROO_DIST" ]; then
    echo "Error: $MUTI_METROO_DIST not found."
    echo "Run ../Muti-Metroo/release.sh (or build Muti Metroo locally) first."
    exit 1
fi
if [ ! -d "$ENTRY_DIST" ]; then
    echo "Error: $ENTRY_DIST not found."
    echo "Run ../Mutiauk/release.sh (or build Mutiauk locally) first."
    exit 1
fi

if command -v sha256sum &>/dev/null; then
    SHA256CMD="sha256sum"
else
    SHA256CMD="shasum -a 256"
fi

MUTI_METROO_VERSION=""
[ -f "$MUTI_METROO_VERSION_FILE" ] && MUTI_METROO_VERSION="v$(tr -d '[:space:]' < "$MUTI_METROO_VERSION_FILE")"
ENTRY_VERSION=""
[ -f "$ENTRY_VERSION_FILE" ] && ENTRY_VERSION="v$(tr -d '[:space:]' < "$ENTRY_VERSION_FILE")"

echo "=== Building downloads bundle ==="
echo "  Muti Metroo version:       ${MUTI_METROO_VERSION:-unknown}"
echo "  Mutiauk version: ${ENTRY_VERSION:-unknown}"

# --- Stage files into a temp directory ---
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Each entry: source-path|archive-name|category|os|arch|type|download-name
# - archive-name:  filename inside the zip (matches the project's release artifact)
# - os/arch/type:  shown as separate columns in the UI
# - download-name: what the browser saves the file as (Content-Disposition)
declare -a ENTRIES=(
    "$MUTI_METROO_DIST/muti-metroo-darwin-arm64|muti-metroo-darwin-arm64|agent|macOS|arm64|executable|muti-metroo"
    "$MUTI_METROO_DIST/muti-metroo-darwin-amd64|muti-metroo-darwin-amd64|agent|macOS|amd64|executable|muti-metroo"
    "$MUTI_METROO_DIST/muti-metroo-linux-amd64|muti-metroo-linux-amd64|agent|Linux|amd64|executable|muti-metroo"
    "$MUTI_METROO_DIST/muti-metroo-linux-arm64|muti-metroo-linux-arm64|agent|Linux|arm64|executable|muti-metroo"
    "$MUTI_METROO_DIST/muti-metroo-windows-amd64.exe|muti-metroo-windows-amd64.exe|agent|Windows|amd64|executable|muti-metroo.exe"
    "$MUTI_METROO_DIST/muti-metroo-windows-arm64.exe|muti-metroo-windows-arm64.exe|agent|Windows|arm64|executable|muti-metroo.exe"
    "$MUTI_METROO_DIST/muti-metroo-windows-amd64.dll|muti-metroo-windows-amd64.dll|agent-dll|Windows|amd64|dll|muti-metroo.dll"
    "$ENTRY_DIST/mutiauk-linux-amd64|mutiauk-linux-amd64|entry|Linux|amd64|executable|mutiauk"
    "$ENTRY_DIST/mutiauk-linux-arm64|mutiauk-linux-arm64|entry|Linux|arm64|executable|mutiauk"
    "$MUTI_METROO_DIST/muti-metroo-user-manual.pdf|muti-metroo-user-manual.pdf|manual||||user-manual.pdf"
    "$MUTI_METROO_DIST/muti-metroo-operator-manual.pdf|muti-metroo-operator-manual.pdf|manual||||operator-manual.pdf"
    "$MUTI_METROO_DIST/muti-metroo-operator-slides.pdf|muti-metroo-operator-slides.pdf|manual||||operator-slides.pdf"
)

# Build manifest as we go
MANIFEST_FILES="[]"

for entry in "${ENTRIES[@]}"; do
    IFS='|' read -r src name category os arch type download_name <<< "$entry"
    if [ ! -f "$src" ]; then
        # The DLL is optional (only built when mingw-w64 is around).
        # Everything else is required.
        if [ "$category" = "agent-dll" ]; then
            echo "  Skipping $name (not present in $MUTI_METROO_DIST)"
            continue
        fi
        echo "Error: required artifact missing: $src"
        exit 1
    fi

    cp "$src" "$STAGE/$name"
    size=$(stat -f %z "$src" 2>/dev/null || stat -c %s "$src")
    sha=$($SHA256CMD "$src" | awk '{print $1}')
    # Pick a per-file version label so the UI can show provenance.
    case "$category" in
        entry) version="$ENTRY_VERSION" ;;
        *)     version="$MUTI_METROO_VERSION" ;;
    esac

    MANIFEST_FILES=$(echo "$MANIFEST_FILES" | jq \
        --arg name "$name" \
        --arg category "$category" \
        --arg os "$os" \
        --arg arch "$arch" \
        --arg type "$type" \
        --arg download_name "$download_name" \
        --argjson size "$size" \
        --arg sha256 "$sha" \
        --arg version "$version" \
        '. + [{name: $name, category: $category, os: $os, arch: $arch, type: $type, download_name: $download_name, size: $size, sha256: $sha256, version: $version}]')

    echo "  + $name → $download_name ($category${os:+, $os/$arch}, $(echo "$size" | awk '{ printf "%.1f MB\n", $1/1048576 }'))"
done

# --- Write manifest.json ---
GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq -n \
    --arg muti_metroo_version "$MUTI_METROO_VERSION" \
    --arg entry_version "$ENTRY_VERSION" \
    --arg generated_at "$GENERATED_AT" \
    --argjson files "$MANIFEST_FILES" \
    '{muti_metroo_version: $muti_metroo_version, entry_version: $entry_version, generated_at: $generated_at, files: $files}' \
    > "$STAGE/manifest.json"

# --- Zip everything ---
mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"
( cd "$STAGE" && zip -q -X "$SCRIPT_DIR/$OUT_ZIP" -- * )

BUNDLE_SIZE=$(stat -f %z "$OUT_ZIP" 2>/dev/null || stat -c %s "$OUT_ZIP")
echo ""
echo "Wrote $OUT_ZIP ($(echo "$BUNDLE_SIZE" | awk '{ printf "%.1f MB\n", $1/1048576 }'))"
