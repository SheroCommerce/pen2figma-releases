#!/bin/bash
# Double-click to remove the pen2figma helper from this Mac.
DEST="$HOME/Library/Application Support/pen2figma"
PLIST="$HOME/Library/LaunchAgents/com.shero.pen2figma.plist"
launchctl unload "$PLIST" 2>/dev/null
rm -f "$PLIST"
rm -rf "$DEST"
echo "pen2figma removed. In Figma, remove the plugin under Plugins > Development > Manage plugins in development."
echo "You can close this window."
