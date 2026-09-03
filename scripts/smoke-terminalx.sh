#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 /path/to/terminalx PROJECT [claude|codex]" >&2
  exit 2
fi

cli=$1
project=$2
agent=${3:-codex}

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for the live smoke test" >&2
  exit 2
fi

status=$("$cli" status --json)
printf '%s\n' "$status" | jq -e '.ok and (.result.appVersion | length > 0) and (.result.socket | length > 0)' >/dev/null

projects=$("$cli" projects list --json)
printf '%s\n' "$projects" | jq -e --arg project "$project" '.ok and any(.result.projects[]; .path == $project or .name == $project)' >/dev/null

created=$("$cli" sessions create --project "$project" --agent "$agent" --prompt "Reply with exactly: terminalx-smoke" --on-main --json)
printf '%s\n' "$created" | jq -e '.ok and (.result.sessionId | length > 0) and (.result.tabId | length > 0)' >/dev/null
session_id=$(printf '%s\n' "$created" | jq -r '.result.sessionId')
tab_id=$(printf '%s\n' "$created" | jq -r '.result.tabId')

waited=$("$cli" wait "$tab_id" --timeout 180 --json)
printf '%s\n' "$waited" | jq -e '.ok and .result.reason == "stop"' >/dev/null

events=$("$cli" read "$tab_id" --tail 50 --json)
printf '%s\n' "$events" | jq -e '.ok and any(.result.events[]; .payload.type == "assistant_text" and (.payload.text | contains("terminalx-smoke")))' >/dev/null

tabs=$("$cli" tabs list "$session_id" --json)
printf '%s\n' "$tabs" | jq -e --arg tab "$tab_id" '.ok and any(.result.tabs[]; .id == $tab)' >/dev/null

printf '%s\n' "$events"
