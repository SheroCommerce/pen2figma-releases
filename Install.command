#!/bin/bash
# Double-click to install (or update) the pen2figma helper on this Mac.
set -e
cd "$(dirname "$0")"
DEST="$HOME/Library/Application Support/pen2figma"

if ! command -v node >/dev/null; then
  echo "Node.js is missing. Opening nodejs.org: install the LTS version, then double-click Install.command again."
  open "https://nodejs.org/en/download"
  exit 1
fi
[ -d /Applications/Pen.app ] || echo "Note: Pen is not in /Applications. Install it before using the plugin."

echo "Installing pen2figma into $DEST"
mkdir -p "$DEST"
rsync -a --delete --exclude .git --exclude .claude --exclude node_modules --exclude out ./ "$DEST/"
cd "$DEST"
npm install --omit=dev --no-audit --no-fund --loglevel=error
node bin/pen2figma.mjs install

open -R "$DEST/plugin/manifest.json"
echo
echo "Done. Last step, in the Figma desktop app:"
echo "  Plugins > Development > Import plugin from manifest..."
echo "  then drag manifest.json from the Finder window that just opened into that dialog."
echo "You can close this window."
