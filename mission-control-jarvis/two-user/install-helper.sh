#!/bin/zsh
# Run in the JARVIS macOS user (signed into Messages with the JARVIS Apple ID).
#   /Users/Shared/jarvis/install-helper.sh            install and start
#   /Users/Shared/jarvis/install-helper.sh uninstall  stop and remove
set -euo pipefail
S=/Users/Shared/jarvis
LABEL="com.herdr.mission-control-jarvis.imessage"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "Helper removed."; exit 0
fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$S/bin/jarvis-imessage</string><string>$S/bin/relay.mjs</string><string>helper</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/jarvis-imessage.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/jarvis-imessage.log</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Helper running."
echo "1. Give Full Disk Access to $S/bin/jarvis-imessage (System Settings → Privacy & Security → Full Disk Access → +, ⌘⇧G)."
echo "2. Allow it to control Messages when macOS asks."
echo "Log: ~/.config/herdr-app/mission-control/jarvis/relay.log"
