#!/bin/bash
# Release script for Muti Metroo Manager
# Bumps version, tags, cross-compiles, builds frontend, creates GitHub release with assets
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# --- Configuration ---
API_URL="https://api.github.com"
UPLOAD_URL="https://uploads.github.com"
REPO="Muti-Metroo/Muti-Metroo-Manager"
VERSION_FILE="VERSION"
BINARY="muti-metroo-manager"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN env var is required}"

# --- Parse arguments ---
BUMP="${1:-patch}"  # patch (default), minor, or major
case "$BUMP" in
    patch|minor|major) ;;
    *) echo "Usage: $0 [patch|minor|major]"; exit 1 ;;
esac

# --- Read and bump version ---
CURRENT_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW_VERSION}"

echo "=== Muti Metroo Manager Release ==="
echo "Current version: $CURRENT_VERSION"
echo "Bump type:       $BUMP"
echo "New version:     $NEW_VERSION"
echo "Tag:             $TAG"
echo ""

# --- Pre-flight checks ---
echo "=== Pre-flight checks ==="

# Required tools
for cmd in go node npm jq curl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: $cmd is required but not found"
        exit 1
    fi
done
echo "  Required tools: OK"

# Branch — release.sh pushes commit + tag to master, so refuse to run
# from any other branch (otherwise the push silently lands on master
# from a feature branch, which is rarely what the operator wanted).
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "master" ]; then
    echo "Error: release.sh must run from master (currently on $CURRENT_BRANCH)"
    exit 1
fi
echo "  Branch: master"

# Uncommitted changes (excluding VERSION)
if ! git diff --quiet --exit-code -- ':!VERSION' || ! git diff --cached --quiet --exit-code -- ':!VERSION'; then
    echo "Error: You have uncommitted changes. Commit or stash them first."
    git status --short
    exit 1
fi
echo "  Working tree: clean"

# Tag existence
if git tag -l "$TAG" | grep -q .; then
    echo "Error: Tag $TAG already exists"
    exit 1
fi
echo "  Tag $TAG: available"

# Optional tools
HAS_UPX=false
UPX_VIA_DOCKER=false
if command -v upx &>/dev/null; then
    HAS_UPX=true
    echo "  UPX: found (native)"
elif command -v docker &>/dev/null; then
    HAS_UPX=true
    UPX_VIA_DOCKER=true
    echo "  UPX: found (via Docker)"
else
    echo "  UPX: not found (binaries will not be compressed)"
fi

# SHA256 command (macOS vs Linux)
if command -v sha256sum &>/dev/null; then
    SHA256CMD="sha256sum"
else
    SHA256CMD="shasum -a 256"
fi

echo ""

# --- Build frontend ---
echo "=== Building frontend ==="
echo -n "  Installing dependencies... "
(cd frontend && npm ci --silent 2>/dev/null)
echo "OK"
echo -n "  Building React app... "
(cd frontend && npm run build --silent 2>/dev/null)
echo "OK"
echo ""

# --- Cross-compile all targets ---
echo "=== Building binaries ==="
LDFLAGS="-s -w -X main.Version=${NEW_VERSION}"

# Format: os:arch:ext:upx
TARGETS=(
    "darwin:arm64::false"
    "darwin:amd64::false"
    "linux:amd64::true"
    "linux:arm64::true"
    "windows:amd64:.exe:true"
    "windows:arm64:.exe:false"
)

rm -rf dist/
mkdir -p dist/

for target in "${TARGETS[@]}"; do
    IFS=':' read -r os arch ext do_upx <<< "$target"
    output="dist/${BINARY}-${os}-${arch}${ext}"
    echo -n "  Building ${os}/${arch}... "
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
        -ldflags="$LDFLAGS" -o "$output" ./cmd/manager
    echo "OK ($(du -h "$output" | cut -f1 | xargs))"
done

echo ""
echo "Built $(ls dist/ | wc -l | tr -d ' ') binaries"

# --- Downloads bundle ---
echo ""
if ./bundle-downloads.sh; then
    BUNDLE_BUILT=true
else
    echo "Warning: bundle-downloads.sh failed; release will not include the downloads bundle."
    echo "         Build/release ../Muti-Metroo and ../Mutiauk first if you want the bundle."
    BUNDLE_BUILT=false
fi

# --- UPX compression ---
echo ""
if $HAS_UPX; then
    echo "=== Compressing binaries with UPX ==="

    UPX_FILES=()
    for target in "${TARGETS[@]}"; do
        IFS=':' read -r os arch ext do_upx <<< "$target"
        if [ "$do_upx" = "true" ]; then
            UPX_FILES+=("${BINARY}-${os}-${arch}${ext}")
        fi
    done

    if $UPX_VIA_DOCKER; then
        echo "  Using Docker (ubuntu:latest + upx)..."
        DOCKER_CMD="apt-get update -qq && apt-get install -y -qq upx-ucl > /dev/null 2>&1"
        for f in "${UPX_FILES[@]}"; do
            DOCKER_CMD+=" && echo -n '  Compressing ${f}... ' && upx --best --lzma /dist/${f} > /dev/null 2>&1 && echo 'OK' || echo 'FAILED'"
        done
        docker run --rm -v "$(pwd)/dist:/dist" ubuntu:latest bash -c "$DOCKER_CMD"
    else
        for f in "${UPX_FILES[@]}"; do
            echo -n "  Compressing ${f}... "
            if upx --best --lzma "dist/${f}" > /dev/null 2>&1; then
                echo "OK ($(du -h "dist/${f}" | cut -f1 | xargs))"
            else
                echo "FAILED (keeping uncompressed)"
            fi
        done
    fi

    echo "  Compressed sizes:"
    for f in "${UPX_FILES[@]}"; do
        echo "    ${f}: $(du -h "dist/${f}" | cut -f1 | xargs)"
    done
else
    echo "=== Skipping UPX compression (upx not found, no Docker) ==="
fi

# --- Generate checksums ---
echo ""
echo "=== Generating checksums ==="
(cd dist && $SHA256CMD -- * > checksums.txt)
echo "  Generated checksums for $(wc -l < dist/checksums.txt | tr -d ' ') files"
cat dist/checksums.txt | sed 's/^/  /'

# --- Update VERSION file, commit, tag, push ---
echo ""
echo "=== Tagging and pushing ==="
echo "$NEW_VERSION" > "$VERSION_FILE"
git add "$VERSION_FILE"
git commit -m "Release $TAG"
echo "  Committed version bump to $NEW_VERSION"

git tag -a "$TAG" -m "Release $TAG"
echo "  Created tag $TAG"

git push origin master
git push origin "$TAG"
echo "  Pushed commit and tag to origin"

# --- Create GitHub release ---
echo ""
echo "=== Creating GitHub release ==="

BUNDLE_SECTION=""
if $BUNDLE_BUILT; then
    BUNDLE_SECTION="

### Downloads bundle
- \`muti-metroo-downloads-bundle.zip\` -- Muti Metroo + Mutiauk binaries and the user manual.
  Drop next to the muti-metroo-manager binary to enable the in-UI Downloads tab."
fi

RELEASE_BODY="## Muti Metroo Manager $TAG

### Binaries
- \`muti-metroo-manager-darwin-arm64\` -- macOS ARM64 (Apple Silicon)
- \`muti-metroo-manager-darwin-amd64\` -- macOS x86_64 (Intel)
- \`muti-metroo-manager-linux-amd64\` -- Linux x86_64
- \`muti-metroo-manager-linux-arm64\` -- Linux ARM64
- \`muti-metroo-manager-windows-amd64.exe\` -- Windows x86_64
- \`muti-metroo-manager-windows-arm64.exe\` -- Windows ARM64${BUNDLE_SECTION}

### Verification
- \`checksums.txt\` -- SHA256 checksums of all artifacts

### Quick Start
\`\`\`bash
chmod +x muti-metroo-manager-linux-amd64
./muti-metroo-manager-linux-amd64 -agent http://127.0.0.1:8080
# Open http://localhost:3000
\`\`\`"

create_release() {
    curl -s -X POST \
        "${API_URL}/repos/${REPO}/releases" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$(jq -n \
            --arg tag "$TAG" \
            --arg name "Muti Metroo Manager $TAG" \
            --arg body "$RELEASE_BODY" \
            '{tag_name: $tag, name: $name, body: $body, draft: false, prerelease: false}'
        )"
}

# Retry release creation (GitHub may need a moment after first push)
RELEASE_ID=""
for attempt in 1 2 3; do
    RELEASE_RESPONSE=$(create_release)
    RELEASE_ID=$(echo "$RELEASE_RESPONSE" | jq -r '.id')
    if [ "$RELEASE_ID" != "null" ] && [ -n "$RELEASE_ID" ]; then
        break
    fi
    if [ "$attempt" -lt 3 ]; then
        echo "  Attempt $attempt failed, retrying in 3s..."
        sleep 3
    fi
done

if [ "$RELEASE_ID" = "null" ] || [ -z "$RELEASE_ID" ]; then
    echo "Error: Failed to create release after 3 attempts"
    echo "$RELEASE_RESPONSE" | jq .
    exit 1
fi
echo "  Created release ID: $RELEASE_ID"

# --- Upload assets ---
echo ""
echo "=== Uploading release assets ==="

upload_asset() {
    local file="$1"
    local name
    name=$(basename "$file")
    echo -n "  Uploading $name... "
    local response
    response=$(curl -s -X POST \
        "${UPLOAD_URL}/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${name}" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/octet-stream" \
        --data-binary "@${file}")
    local asset_id
    asset_id=$(echo "$response" | jq -r '.id')
    if [ "$asset_id" = "null" ] || [ -z "$asset_id" ]; then
        echo "FAILED"
        echo "$response" | jq .
        return 1
    fi
    local size
    size=$(echo "$response" | jq -r '.size')
    echo "OK ($(numfmt --to=iec "$size" 2>/dev/null || echo "${size} bytes"))"
}

for file in dist/*; do
    upload_asset "$file"
done

# --- Verify release ---
echo ""
echo "=== Verifying release ==="
VERIFY=$(curl -s "${API_URL}/repos/${REPO}/releases/tags/${TAG}" \
    -H "Authorization: Bearer ${TOKEN}")
ASSET_COUNT=$(echo "$VERIFY" | jq '.assets | length')
echo "  Release: $(echo "$VERIFY" | jq -r '.name')"
echo "  Tag:     $(echo "$VERIFY" | jq -r '.tag_name')"
echo "  Assets:  $ASSET_COUNT"
echo "$VERIFY" | jq -r '.assets[] | "  - \(.name) (\(.size) bytes)"'

echo ""
echo "=== Release $TAG complete ==="
echo "URL: https://github.com/${REPO}/releases/tag/${TAG}"
