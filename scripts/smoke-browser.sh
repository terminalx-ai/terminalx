#!/bin/sh
# Live smoke test of the built-in browser through the terminalx CLI against
# a running TerminalX app: serves a static page, opens it in a workspace's
# browser, and runs the snapshot → click → re-snapshot loop the guide teaches.
# Commands run from inside the workspace so the unqualified scoping rule
# (the caller's checkout, its active page) is what gets exercised.
#
#   scripts/smoke-browser.sh /path/to/terminalx /path/to/workspace
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 /path/to/terminalx WORKSPACE_PATH" >&2
  exit 2
fi
cli=$1
workspace=$2
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 2; }

site=$(mktemp -d)
cat > "$site/index.html" <<'HTML'
<!doctype html><title>Smoke Page</title><h1>Hello</h1>
<a href="second.html">Go second</a>
<input placeholder="Name"><button>Press</button>
HTML
printf '<!doctype html><title>Second</title><p>Second page</p>' > "$site/second.html"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
(cd "$site" && python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) &
server=$!
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null; rm -rf "$site"' EXIT
sleep 1

"$cli" status --json | jq -e '.ok' >/dev/null
cd "$workspace"

# Nothing open yet: the typed error names the recovery.
none=$("$cli" snapshot --json || true)
printf '%s\n' "$none" | jq -e '.ok == false and .error.code == "browser_no_tab"' >/dev/null

created=$("$cli" tab create --url "http://127.0.0.1:$port/index.html" --json)
printf '%s\n' "$created" | jq -e '.ok and (.result.browserPageId | startswith("bp-"))' >/dev/null
page=$(printf '%s\n' "$created" | jq -r '.result.browserPageId')

"$cli" tab list --json | jq -e --arg page "$page" '.ok and any(.result.tabs[]; .browserPageId == $page and .active and (.url | contains("index.html")))' >/dev/null
"$cli" tab list --worktree all --json | jq -e --arg page "$page" '.ok and any(.result.tabs[]; .browserPageId == $page)' >/dev/null

# Unqualified commands hit the workspace's active page.
"$cli" tab current --json | jq -e --arg page "$page" '.ok and .result.tab.browserPageId == $page' >/dev/null
snapshot=$("$cli" snapshot --page "$page" --json)
printf '%s\n' "$snapshot" | jq -e '.ok and .result.title == "Smoke Page" and (.result.refs | length > 0)' >/dev/null
link=$(printf '%s\n' "$snapshot" | jq -r '.result.refs[] | select(.name == "Go second") | .ref')
name=$(printf '%s\n' "$snapshot" | jq -r '.result.refs[] | select(.name == "Name") | .ref')

"$cli" click --element "$link" --page "$page" --json | jq -e '.ok' >/dev/null
"$cli" wait --url second.html --page "$page" --json | jq -e '.ok' >/dev/null

# The old ref is dead after navigation and says so.
stale=$("$cli" fill --element "$name" --value x --page "$page" --json || true)
printf '%s\n' "$stale" | jq -e '.ok == false and .error.code == "browser_stale_ref"' >/dev/null

"$cli" back --page "$page" --json | jq -e '.ok and (.result.url | contains("index.html"))' >/dev/null
snapshot=$("$cli" snapshot --page "$page" --json)
name=$(printf '%s\n' "$snapshot" | jq -r '.result.refs[] | select(.name == "Name") | .ref')
"$cli" fill --element "$name" --value hello --page "$page" --json | jq -e '.ok' >/dev/null
"$cli" get --what value --element "$name" --page "$page" --json | jq -e '.ok and .result.value == "hello"' >/dev/null

shot=$("$cli" screenshot --page "$page" --json)
printf '%s\n' "$shot" | jq -e '.ok and .result.bytes > 0' >/dev/null
test -f "$(printf '%s\n' "$shot" | jq -r '.result.path')"

"$cli" console --page "$page" --json | jq -e '.ok' >/dev/null
"$cli" cookie get --page "$page" --json | jq -e '.ok and (.result.cookies | type == "array")' >/dev/null

"$cli" tab close --page "$page" --json | jq -e --arg page "$page" '.ok and .result.closed == $page' >/dev/null
"$cli" tab list --json | jq -e --arg page "$page" '.ok and all(.result.tabs[]; .browserPageId != $page)' >/dev/null
missing=$("$cli" tab show --page "$page" --json || true)
printf '%s\n' "$missing" | jq -e '.ok == false and .error.code == "browser_tab_not_found"' >/dev/null

echo "browser smoke passed for $page"
