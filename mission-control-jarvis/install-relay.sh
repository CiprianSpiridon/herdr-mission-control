#!/bin/zsh
# Installs the J.A.R.V.I.S. iMessage relay as a launchd agent.
#   ./install-relay.sh            install or update, then (re)start it
#   ./install-relay.sh uninstall  stop it and remove the launchd agent (keeps relay.json)
set -euo pipefail

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
PKG="$(cd "$(dirname "$0")" && pwd)"
DIR="$APP_HOME/mission-control/jarvis"
BIN="$DIR/bin"
LABEL="com.herdr.mission-control-jarvis.relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RELAY="$APP_HOME/mods/mission-control-jarvis/relay.mjs"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Relay stopped and removed. Settings kept in $DIR/relay.json"
  exit 0
fi

mkdir -p "$BIN" "$DIR/orchestrator/.claude" "$HOME/Library/LaunchAgents"

# The mod (with relay.mjs) is installed by the package install; copy relay.mjs if it's missing.
[[ -f "$RELAY" ]] || cp "$PKG/mods/mission-control-jarvis/relay.mjs" "$RELAY"

# A dedicated copy of node, so Full Disk Access (needed to read your Messages replies)
# goes to the relay only, not to every node script on the Mac.
NODE_SRC="$(readlink -f "$(command -v node)")"
if [[ ! -x "$BIN/jarvis-relay" ]] || ! cmp -s "$NODE_SRC" "$BIN/jarvis-relay"; then
  cp "$NODE_SRC" "$BIN/jarvis-relay"
fi

# jarvis-text "<message>": queue an iMessage to you. Used by the jarvis session, briefings and routines.
cat > "$BIN/jarvis-text" <<EOF
#!/bin/zsh
exec "$BIN/jarvis-relay" "$RELAY" send "\$@"
EOF
chmod +x "$BIN/jarvis-text"

# The orchestrator session's instructions and permissions.
cp "$PKG/orchestrator/CLAUDE.md" "$DIR/orchestrator/CLAUDE.md"
cp "$PKG/orchestrator/.claude/settings.json" "$DIR/orchestrator/.claude/settings.json"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN/jarvis-relay</string>
    <string>$RELAY</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HERDR_APP_HOME</key><string>$APP_HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/relay.out</string>
  <key>StandardErrorPath</key><string>$DIR/relay.out</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Relay running ($LABEL)."
echo "Settings: $DIR/relay.json   Log: $DIR/relay.log"
echo "Give Full Disk Access to: $BIN/jarvis-relay"
