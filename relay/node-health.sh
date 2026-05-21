#!/usr/bin/env bash
# node-health.sh — Check all services on this XMRT DAO node
# Usage: bash node-health.sh

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

checks=0
passed=0

check() {
  local name="$1"
  local url="$2"
  local expect="$3"
  checks=$((checks + 1))
  
  result=$(curl -s --max-time 3 "$url" 2>/dev/null || echo "FAIL")
  
  if echo "$result" | grep -q "$expect"; then
    echo -e "  ${GREEN}✅${NC} $name"
    passed=$((passed + 1))
  else
    echo -e "  ${RED}❌${NC} $name — ${result:0:80}"
  fi
}

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     XMRT DAO Node Health Check            ║"
echo "╚══════════════════════════════════════════╝"
echo ""

echo "📡 Relay Services"
check "Relay Server" "http://localhost:8080/health" '"status":"ok"'
check "Tools Registry" "http://localhost:8080/tools" '"total":'
check "Mesh Routes" "http://localhost:8080/mesh/status" '"status":"running"'
check "Fleet Chat" "http://localhost:8080/api/fleet-chat/agents" '"agents"'

echo ""
echo "🕸️  Mesh Network"
check "Gossipsub P2P" "http://localhost:8080/mesh/status" '"peerId"'
check "Python P2P (4002)" "http://localhost:4002/health" '"ok"'

echo ""
echo "🌐 Cloud Infrastructure"
check "Tunnel (relay.mobilemonero.com)" "https://relay.mobilemonero.com/health" '"status":"ok"'
check "API Gateway" "https://api.mobilemonero.com/health" '"ok":true'
check "Fleet Status" "https://fleet.mobilemonero.com/health" '"ok":true'
check "Price Feed" "https://price.mobilemonero.com/price/xmr" '"price_usd"'
check "Hermes" "https://hermes.mobilemonero.com/health" '"ok":true'
check "Inbox" "https://inbox.mobilemonero.com/health" '"ok"'

echo ""
echo "⚡ Local Infrastructure"
check "Ollama" "http://localhost:11434/api/tags" '"models"'

echo ""
echo "────────────────────────────────────"
echo -e "  ${GREEN}${passed}${NC}/${checks} checks passed"
echo ""

if [ "$passed" -eq "$checks" ]; then
  echo -e "  ${GREEN}All systems nominal.${NC}"
else
  echo -e "  ${YELLOW}$((checks - passed)) checks failed. Review above.${NC}"
fi
echo ""
