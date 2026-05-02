#!/usr/bin/env bash
# Set up dist/<browser>/ for local testing and (for firefox) launch web-ext.
# dist/<browser>/ is a tree of symlinks back into src/, with the right
# manifest copied in. Both browsers can run side-by-side without clobbering
# each other's manifest.
#
# Usage:
#   ./dev.sh firefox     # symlinks + launches web-ext run
#   ./dev.sh chrome      # symlinks; load dist/chrome/ as unpacked in chrome://extensions
#
# Re-run any time after editing a manifest variant (other src/ edits are picked
# up live through the symlinks).

set -euo pipefail

browser="${1:-}"
case "$browser" in
  firefox|chrome) ;;
  *) echo "Usage: $0 <firefox|chrome>" >&2; exit 1 ;;
esac

repo="$(cd "$(dirname "$0")" && pwd)"
src="$repo/src"
dst="$repo/dist/$browser"

mkdir -p "$dst"

# Symlink each child of src/ into dst/, skipping variant manifests and dev artifacts.
for path in "$src"/* "$src"/.[!.]*; do
  [ -e "$path" ] || continue
  name=$(basename "$path")
  case "$name" in
    *_manifest.json|manifest.json|web-ext-artifacts) continue ;;
  esac
  ln -snf "$path" "$dst/$name"
done

# Hard-copy the right manifest. Re-run this script if the variant changes.
cp "$src/${browser}_manifest.json" "$dst/manifest.json"

echo "Ready: $dst"

case "$browser" in
  firefox)
    echo "Launching: web-ext run -s $dst"
    cd "$dst" && exec web-ext run
    ;;
  chrome)
    echo "In chrome://extensions, enable Developer mode and 'Load unpacked' → $dst"
    ;;
esac
