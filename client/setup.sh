#!/usr/bin/env bash
# Usage: BUS_HOST=user@your-server ./setup.sh <your-bus-token>
#        BUS_HOST=user@your-server ./setup.sh --invite <code-from-the-group-chat>
#        add --gate first to also install the hard approval gate for pushes, server writes and deploys
# Connects this machine's Claude Code to agent-bus and installs the inbox hook.
set -euo pipefail

GATE=""
if [ "${1:-}" = "--gate" ]; then GATE=1; shift; fi
INVITE=""
if [ "${1:-}" = "--invite" ]; then
  INVITE="${2:?usage: setup.sh --invite <code>}"
else
  TOKEN="${1:?usage: setup.sh <token> | setup.sh --invite <code>}"
fi
# The bus listens on the box's loopback only. Every client reaches it through an ssh
# tunnel, so there is nothing to expose and nothing to guard on the open internet.
BUS_URL="${BUS_URL:-http://127.0.0.1:47830}"
BUS_HOST="${BUS_HOST:?set BUS_HOST=user@your-server - the box that runs the bus}"
BUS_LANG="${BUS_LANG:-en}"

if ! curl -sf --max-time 3 "$BUS_URL/healthz" >/dev/null; then
  echo "no bus on $BUS_URL - opening the tunnel"
  ssh -fN -o ExitOnForwardFailure=yes -L 127.0.0.1:47830:127.0.0.1:47830 "$BUS_HOST"
  sleep 1
fi
if [ -n "$INVITE" ]; then
  CLAIM="$(curl -sf -X POST "$BUS_URL/api/claim" -H 'content-type: application/json' -d "{\"code\":\"$INVITE\"}")" \
    || { echo "the invite code is unknown, used or expired - ask an admin for a new one"; exit 1; }
  TOKEN="$(printf '%s' "$CLAIM" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
  echo "joined as: $(printf '%s' "$CLAIM" | python3 -c 'import json,sys; print(json.load(sys.stdin)["agent"])')"
fi
HOOK_DIR="$HOME/.claude/hooks"
NODE_BIN="$(command -v node)"

mkdir -p "$HOOK_DIR"
cp "$(dirname "$0")/agent-bus-ping.mjs" "$HOOK_DIR/agent-bus-ping.mjs"
cp "$(dirname "$0")/agent-bus-gate.mjs" "$HOOK_DIR/agent-bus-gate.mjs"
chmod +x "$HOOK_DIR/agent-bus-ping.mjs" "$HOOK_DIR/agent-bus-gate.mjs"

printf '{ "url": "%s", "token": "%s", "lang": "%s" }\n' "$BUS_URL" "$TOKEN" "$BUS_LANG" > "$HOME/.claude/agent-bus.json"
chmod 600 "$HOME/.claude/agent-bus.json"

claude mcp add --transport http agent-bus "$BUS_URL/mcp" \
  --header "Authorization: Bearer $TOKEN" --scope user

python3 - "$NODE_BIN" "$GATE" <<'PY'
import json, os, shutil, sys
node = sys.argv[1]
path = os.path.expanduser('~/.claude/settings.json')
if os.path.exists(path):
    shutil.copy(path, path + '.bak-agentbus')
    data = json.load(open(path))
else:
    data = {}
hooks = data.setdefault('hooks', {})
command = f"{node} {os.path.expanduser('~/.claude/hooks/agent-bus-ping.mjs')}"
for event in ('Stop', 'SessionStart'):
    groups = hooks.setdefault(event, [])
    if any('agent-bus-ping' in h.get('command', '') for g in groups for h in g.get('hooks', [])):
        continue
    groups.append({'hooks': [{'type': 'command', 'command': command}]})
# Optional hard gate (--gate): pushes, server writes and deploys wait for an approved request.
if len(sys.argv) > 2 and sys.argv[2] == '1':
    gate = f"{node} {os.path.expanduser('~/.claude/hooks/agent-bus-gate.mjs')}"
    pre = hooks.setdefault('PreToolUse', [])
    if not any('agent-bus-gate' in h.get('command', '') for g in pre for h in g.get('hooks', [])):
        pre.append({'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': gate}]})
json.dump(data, open(path, 'w'), ensure_ascii=False, indent=2)
print('hooks registered')
PY

echo "--- checking the bus ---"
curl -s "$BUS_URL/api/ping" -H "Authorization: Bearer $TOKEN"
echo
echo "Done. Ask your Claude: bus_status"
