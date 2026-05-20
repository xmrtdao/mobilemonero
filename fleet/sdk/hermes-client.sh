#!/usr/bin/env bash
#
# Fleet Agent SDK — Hermes Direct Endpoint
# https://hermes.mobilemonero.com
# Version: 1.0.0
# Usage: source hermes-client.sh
#
HERMES_URL="${HERMES_URL:-https://hermes.mobilemonero.com}"
AGENT_NAME="${AGENT_NAME:-unknown}"

# --- core helpers ---

curl_hermes() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" "$HERMES_URL$path" -H "Content-Type: application/json" -d "$data"
  else
    curl -sS -X "$method" "$HERMES_URL$path"
  fi
}

# --- health ---
hermes_health() {
  curl_hermes "GET" "/health"
}

# --- heartbeat ---
hermes_heartbeat() {
  local agent="${1:-$AGENT_NAME}"
  curl_hermes "GET" "/fleet/heartbeat?agent=$agent"
}

# --- broadcast (all agents see it) ---
hermes_broadcast() {
  local msg="$1"
  local type="${2:-broadcast}"
  local agent="${3:-$AGENT_NAME}"
  curl_hermes "POST" "/fleet/broadcast" \
    "{\"agent\":\"$agent\",\"message\":\"$msg\",\"type\":\"$type\"}"
}

# --- send TO hermes ---
hermes_to_hermes() {
  local msg="$1"
  local type="${2:-direct}"
  local agent="${3:-$AGENT_NAME}"
  curl_hermes "POST" "/to/hermes" \
    "{\"agent\":\"$agent\",\"message\":\"$msg\",\"type\":\"$type\"}"
}

# --- send FROM hermes TO another agent ---
# (usually Hermes calls this, but agents can proxy via Hermes if needed)
hermes_from_hermes() {
  local to_agent="$1"
  local msg="$2"
  local type="${3:-direct}"
  curl_hermes "POST" "/from/hermes" \
    "{\"to\":\"$to_agent\",\"message\":\"$msg\",\"type\":\"$type\"}"
}

# --- poll messages for this agent ---
hermes_poll() {
  local agent="${1:-$AGENT_NAME}"
  local limit="${2:-50}"
  curl_hermes "GET" "/from/hermes/$agent?limit=$limit"
}

# --- get message log ---
hermes_messages() {
  local limit="${1:-50}"
  curl_hermes "GET" "/fleet/messages?limit=$limit"
}

# --- fleet status ---
hermes_fleet_status() {
  curl_hermes "GET" "/fleet/status"
}

# --- convenience: poll and print ---
hermes_poll_pretty() {
  hermes_poll "$@" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{m[\"id\"]}: {m[\"from\"]} -> {m[\"to\"]}: {m[\"message\"]}') for m in d.get('messages',[])]"
}
