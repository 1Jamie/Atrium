#!/usr/bin/env bash
# Build Atrium-<ver>-x86_64.AppImage: bash header + tar.xz. Not a FUSE AppImage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT}/package.json').version")"
STAGE="$(mktemp -d)"
HEADER="$(mktemp)"
PAYLOAD="$(mktemp)"
OUT="${1:-${ROOT}/dist/Atrium-${VERSION}-x86_64.AppImage}"

cleanup() {
  rm -rf "$STAGE" "$HEADER" "$PAYLOAD"
}
trap cleanup EXIT

mkdir -p "$STAGE/bin" "$STAGE/ui" "$STAGE/lib" "$STAGE/plugins" "$STAGE/scripts"
if [[ -d "${ROOT}/dist/app" ]]; then
  cp -a "${ROOT}/dist/app/." "$STAGE/"
fi
cp -a "${ROOT}/ui/." "$STAGE/ui/"
cp -a "${ROOT}/lib/." "$STAGE/lib/"
cp -a "${ROOT}/plugins/." "$STAGE/plugins/"
cp -a "${ROOT}/scripts/install-plugin.js" "${ROOT}/scripts/pack-plugin.js" "$STAGE/scripts/"
cp -a "${ROOT}/bin/atrium" "$STAGE/bin/atrium"
chmod 755 "$STAGE/bin/atrium"
if [[ -f "${ROOT}/main.js" ]]; then
  cp -a "${ROOT}/main.js" "$STAGE/main.js"
fi

# Record the launcher path so a later install can recognize its own symlink.
mkdir -p "$STAGE"
: > "$STAGE/MANIFEST"
printf '%s\n' "bin/atrium" >> "$STAGE/MANIFEST"

cp "${ROOT}/scripts/installer-header.sh" "$HEADER"
# Stamp version. ARCHIVE_OFFSET stays 8 digits until we know the header size.
sed -i "s/^# VERSION=.*/# VERSION=${VERSION}/" "$HEADER"
sed -i "s/^VERSION=.*/VERSION=${VERSION}/" "$HEADER"

# Placeholder is already 8 digits. Measure, then rewrite the same width so
# the byte length does not change. Sed runs on the header file only.
OFFSET="$(wc -c < "$HEADER" | tr -d ' ')"
PADDED="$(printf '%08d' "$OFFSET")"
sed -i "s/^# ARCHIVE_OFFSET=.*/# ARCHIVE_OFFSET=${PADDED}/" "$HEADER"
sed -i "s/^ARCHIVE_OFFSET=.*/ARCHIVE_OFFSET=${PADDED}/" "$HEADER"
ACTUAL="$(wc -c < "$HEADER" | tr -d ' ')"
if [[ "$ACTUAL" != "$OFFSET" ]]; then
  echo "mkinstaller: header size changed while padding ARCHIVE_OFFSET ($OFFSET -> $ACTUAL)" >&2
  exit 1
fi

tar -C "$STAGE" -cJf "$PAYLOAD" .
mkdir -p "$(dirname "$OUT")"
cat "$HEADER" "$PAYLOAD" > "$OUT"
chmod 755 "$OUT"
echo "mkinstaller: $OUT (offset ${PADDED})"
