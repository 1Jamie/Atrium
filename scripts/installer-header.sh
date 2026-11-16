#!/bin/sh
# ATRIUM_INSTALLER 1
# VERSION=0.1.0
# ARCH=x86_64
# PAYLOAD_SHA256=0000000000000000000000000000000000000000000000000000000000000000
# ARCHIVE_OFFSET=00000000
# Fixed-width ARCHIVE_OFFSET is filled by mkinstaller.sh before concat.
# Extract with: tail -c +$((ARCHIVE_OFFSET + 1)) "$0" | tar -xJ
set -eu

VERSION=0.1.0
ARCHIVE_OFFSET=00000000

atrium_die() {
  printf 'atrium-installer: %s\n' "$1" >&2
  exit 1
}

atrium_prefix_default() {
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    printf '%s/atrium\n' "$XDG_DATA_HOME"
  else
    printf '%s/.local/share/atrium\n' "$HOME"
  fi
}

# True when ~/.local/bin/atrium is ours to replace.
atrium_symlink_owned() {
  link="$1"
  prefix="$2"
  [ -L "$link" ] || return 1
  target=$(readlink -f "$link" 2>/dev/null || true)
  [ -n "$target" ] || return 1
  case "$target" in
    "$prefix"/bin/atrium) return 0 ;;
  esac
  # Previous install recorded in the old prefix manifest.
  old="$prefix/MANIFEST"
  if [ -f "$old" ] && grep -F -x -q "$target" "$old"; then
    return 0
  fi
  return 1
}

atrium_install_symlink() {
  prefix="$1"
  bin_dir="${HOME}/.local/bin"
  link="$bin_dir/atrium"
  mkdir -p "$bin_dir"
  if [ -e "$link" ] || [ -L "$link" ]; then
    if atrium_symlink_owned "$link" "$prefix"; then
      rm -f "$link"
    else
      atrium_die "refusing to replace $link (not an Atrium install)"
    fi
  fi
  ln -s "$prefix/bin/atrium" "$link"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf 'atrium-installer: add %s to PATH\n' "$bin_dir" ;;
  esac
}

atrium_uninstall() {
  prefix="$1"
  purge="$2"
  link="${HOME}/.local/bin/atrium"
  owned=0
  if atrium_symlink_owned "$link" "$prefix"; then
    owned=1
  fi
  if [ -d "$prefix" ]; then
    rm -rf "$prefix"
  fi
  if [ "$owned" = 1 ]; then
    rm -f "$link"
  fi
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/lotus-atrium/resource-root"
  rm -rf "$cache"
  if [ "$purge" = 1 ]; then
    cfg="${XDG_CONFIG_HOME:-$HOME/.config}/lotus-atrium"
    rest="${XDG_CACHE_HOME:-$HOME/.cache}/lotus-atrium"
    rm -rf "$cfg" "$rest"
  fi
  printf 'atrium-installer: removed %s\n' "$prefix"
}

atrium_extract() {
  dest="$1"
  mkdir -p "$dest"
  tail -c +$((ARCHIVE_OFFSET + 1)) "$0" | tar -xJ -C "$dest"
}

PREFIX=$(atrium_prefix_default)
PURGE=0
MODE=install

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE=uninstall ;;
    --purge) PURGE=1 ;;
    --prefix)
      shift
      PREFIX="${1:-}"
      [ -n "$PREFIX" ] || atrium_die "--prefix needs a path"
      ;;
    --prefix=*) PREFIX="${1#--prefix=}" ;;
    --appimage-extract)
      MODE=extract
      ;;
    --appimage-extract-and-run|--run) MODE=run ;;
    --help|-h)
      printf 'usage: %s [--uninstall] [--purge] [--prefix DIR] [--run] [--appimage-extract]\n' "$0"
      exit 0
      ;;
    *) atrium_die "unknown argument: $1" ;;
  esac
  shift
done

case "$MODE" in
  uninstall)
    atrium_uninstall "$PREFIX" "$PURGE"
    exit 0
    ;;
  extract)
    atrium_extract "./squashfs-root"
    printf 'atrium-installer: extracted to ./squashfs-root\n'
    exit 0
    ;;
esac

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
atrium_extract "$STAGING"

if [ "$MODE" = run ]; then
  exec "$STAGING/bin/atrium" "$@"
fi

# Full prefix replace (upgrade and downgrade).
BAK="${PREFIX}.bak"
rm -rf "$BAK"
if [ -d "$PREFIX" ]; then
  mv "$PREFIX" "$BAK"
fi
mkdir -p "$(dirname "$PREFIX")"
if ! mv "$STAGING" "$PREFIX"; then
  if [ -d "$BAK" ]; then mv "$BAK" "$PREFIX"; fi
  atrium_die "failed to move staging into $PREFIX"
fi
trap - EXIT
rm -rf "$BAK"
printf '%s\n' "$VERSION" > "$PREFIX/VERSION"
atrium_install_symlink "$PREFIX"
printf 'atrium-installer: installed %s at %s\n' "$VERSION" "$PREFIX"
exit 0
