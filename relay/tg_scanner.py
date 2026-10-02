import json, re, sys

# Load the fleet messages dump
with open(r"C:\Users\PureTrek\Desktop\xmrtdao\relay\fleet_messages_scan.txt", "r", encoding="utf-8") as f:
    raw = f.read()

# The file is double-encoded JSON: outer JSON with a "result" key containing a JSON string
data = json.loads(raw)
inner = json.loads(data["result"])
rows = inner["rows"]

# Agent name normalization
def canon(name):
    m = {
        "vex": "@vex", "vex-001": "@vex",
        "eliza": "@eliza", "eliza-001": "@eliza", "eliza-cloud": "@eliza", "elizacloud": "@eliza",
        "alice": "@alice", "alice-001": "@alice",
        "hermes": "@hermes", "hermes-001": "@hermes", "hermes-agent": "@hermes",
        "joe": "@joe", "joe-001": "@joe",
        "trib": "@trib", "trib-001": "@trib",
        "arch": "@arch", "arch-001": "@arch",
        "builder": "@builder",
        "productivity": "@productivity",
        "pfp": "@pfp",
        "global-communicator": "@global-communicator",
    }
    return m.get(name.lower(), name.lower())

# Violation patterns
violations = []

def add_v(agent, msg_id, vtype, severity, excerpt, reason):
    violations.append({
        "agent": canon(agent),
        "msg_id": msg_id,
        "type": vtype,
        "severity": severity,
        "excerpt": excerpt[:400],
        "reason": reason,
    })

# Scan each message
for row in rows:
    agent = row.get("agent_id", "")
    msg = row.get("message", "") or ""
    msg_id = row.get("id", "")
    # Skip system telemetry
    if agent.lower() in ("system", ""):
        continue

    # 1. Raw tool output leakage (operational agents only)
    if agent.lower() not in ("system", "hermes-agent", "global-communicator"):
        if "_authorized" in msg and "tool_name" in msg:
            add_v(agent, msg_id, "raw_tool_output_leakage", "high",
                  msg, "Message contains _authorized + tool_name fields")

    # 2. TOOL_CALL JSON leakage
    if "TOOL_CALL" in msg or "<tool_call>" in msg:
        add_v(agent, msg_id, "tool_call_json_leakage", "high",
              msg, "Raw TOOL_CALL or <tool_call> present in public message")

    # 3. Internal reasoning leakage
    if re.search(r"(?i)my plan[:\s]|my reasoning[:\s]|internal plan[:\s]|step \d+[:\s]|next i will|let me outline", msg):
        add_v(agent, msg_id, "internal_reasoning_leakage", "medium",
              msg, "Internal planning/reasoning leaked into public channel")

    # 4. Context injection leakage
    if re.search(r"(?i)recent conversation context[:\s]|context provided[:\s]|here is the context|system prompt", msg):
        add_v(agent, msg_id, "context_injection_leakage", "medium",
              msg, "Context block or system prompt leaked")

    # 5. Capability fabrication
    if re.search(r"(?i)i (can|will|have) (deployed|fixed|restarted|rebuilt|upgraded|patched|resolved) .*?(server|database|relay|edge function|pipeline)", msg):
        add_v(agent, msg_id, "capability_fabrication", "critical",
              msg, "Operational claim about deploying/fixing infrastructure without evidence")

    # 6. False absence claims
    if re.search(r"(?i)nothing existed yet|i searched and found nothing|no prior knowledge|no prior record|there (is|was) no .*?(data|record|log|history)", msg):
        add_v(agent, msg_id, "false_absence_claim", "medium",
              msg, "Claimed absence of data/records")

    # 7. Credential exposure
    if re.search(r"\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{30,}|api[_-]?key[:\s]*[a-zA-Z0-9]{16,}|password[:\s]*\S{8,})", msg):
        add_v(agent, msg_id, "credential_exposure", "critical",
              msg, "Potential credential/API key exposed")

    # 8. Unverified commit hashes (with guardrails)
    if not re.search(r"(?i)relay health|task pipeline|stuck >24h|pending stage|task id:|backlog", msg):
        hash_matches = re.findall(r"\b[a-f0-9]{7,40}\b", msg)
        for h in hash_matches:
            if re.search(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", msg):
                continue
            if len(h) == 8 and re.search(r"(?i)task|pending|claimed|stuck|idle", msg):
                continue
            if re.search(r"(?i)commit|pr|merged|deployed|branch|deploy|build", msg):
                add_v(agent, msg_id, "unverified_commit_hash", "low",
                      msg, f"Hash-like string '{h}' in potential code context without verification")

# Sort and deduplicate
seen = set()
unique = []
for v in violations:
    key = (v["msg_id"], v["type"])
    if key not in seen:
        seen.add(key)
        unique.append(v)
violations = unique
violations.sort(key=lambda x: ("critical", "high", "medium", "low").index(x["severity"]))

# Print summary
count = len(violations)
if count == 0:
    print("No TrustGraph violations found in the last 48 hours.")
    sys.exit(0)

print(f"TrustGraph Violation Scan Results — {count} violation(s) found in last 48h\n")
print("=" * 60)

for v in violations:
    print(f"\n[{v['severity'].upper()}] {v['type']}")
    print(f"  Agent:    {v['agent']}")
    print(f"  Msg ID:   {v['msg_id']}")
    print(f"  Reason:   {v['reason']}")
    excerpt = v['excerpt'].replace('\n', ' ')
    print(f"  Excerpt:  {excerpt[:200]}{'...' if len(excerpt) > 200 else ''}")

print("\n" + "=" * 60)
print(f"\nTotal violations: {count}")
print("Severity breakdown:")
for sev in ["critical", "high", "medium", "low"]:
    c = sum(1 for v in violations if v["severity"] == sev)
    if c:
        print(f"  {sev}: {c}")
