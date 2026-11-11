#!/bin/zsh
# Run in YOUR macOS user. Prepares /Users/Shared/jarvis so the JARVIS user's helper can
# send and receive iMessages for the relay, and switches the relay to that mode.
#   ./setup-shared.sh +15551234567
set -euo pipefail
TO="${1:?usage: setup-shared.sh <your phone number or Apple ID>}"
PKG="$(cd "$(dirname "$0")/.." && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
S=/Users/Shared/jarvis
mkdir -p "$S/bin" "$S/out" "$S/in"
chmod 755 "$S" "$S/bin"
chmod 777 "$S/out" "$S/in"          # both users drop and take message files here
cp "$PKG/mods/mission-control-jarvis/relay.mjs" "$S/bin/relay.mjs"
NODE_SRC="$(readlink -f "$(command -v node)")"
cmp -s "$NODE_SRC" "$S/bin/jarvis-imessage" 2>/dev/null || cp "$NODE_SRC" "$S/bin/jarvis-imessage"
cp "$PKG/two-user/install-helper.sh" "$S/install-helper.sh"
printf '#!/bin/zsh\n/Users/Shared/jarvis/install-helper.sh\necho\necho "Done. You can close this window."\n' > "$S/Install JARVIS.command"
chmod 755 "$S/bin/jarvis-imessage" "$S/install-helper.sh" "$S/Install JARVIS.command"
chmod 644 "$S/bin/relay.mjs"
printf '{"to":"%s"}\n' "$TO" > "$S/helper.json"; chmod 644 "$S/helper.json"
# Relay: talk through the shared folder, not this user's Messages.
/usr/bin/python3 - "$APP_HOME/mission-control/jarvis/relay.json" "$TO" <<'PY'
import json, sys, os
f, to = sys.argv[1], sys.argv[2]
c = json.load(open(f)) if os.path.exists(f) else {}
c.update({"to": to, "transport": "shared", "self": False})
json.dump(c, open(f, "w"), indent=2)
PY
echo "Shared folder ready at $S."
echo "Now switch to the JARVIS user, open Terminal and run:  $S/install-helper.sh"
