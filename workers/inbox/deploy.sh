#!/bin/bash
# inbox Worker — Deploy via Cloudflare REST API (Termux-compatible)
set -euo pipefail

SCRIPT=$(cat <><<'EOF'
const SHARED_SECRET="mmx-shared-2026-inbox-v1";const PFP_INBOX=[];const XMRT_INBOX=[];const SENT_EMAILS=[];function now(){return new Date().toISOString();}function auth_fail(){return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:{"Content-Type":"application/json"}});}function check_auth(r){const h=r.headers.get("Authorization")||"";if(!h.startsWith("Bearer "))return false;return h.slice(7)===SHARED_SECRET;}function jsonResponse(d,s=200){return new Response(JSON.stringify(d),{status:s,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});}function handleWebhook(b,store){const r={id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),from:b.from||b.senderEmail||"",to:b.to||"",subject:b.subject||"",text:b.text||"",html:b.html||"",created_at:b.created_at||now(),raw:b};store.unshift(r);if(store.length>5000)store.length=5000;return jsonResponse({ok:true,id:r.id});}function listInbox(store,url){if(!check_auth){return auth_fail();}const L=Math.min(parseInt(url.searchParams.get("limit")||"50"),100);const O=parseInt(url.searchParams.get("offset")||"0");const items=store.slice(O,O+L).map(e=\u003e({id:e.id,from:e.from,to:e.to,subject:e.subject,created_at:e.created_at}));return jsonResponse({total:store.length,limit:L,offset:O,items});}function brief(){const l1=PFP_INBOX[0];const l2=XMRT_INBOX[0];return jsonResponse({pfp:{count:PFP_INBOX.length,latest_subject:l1?l1.subject:null},mobilemonero:{count:XMRT_INBOX.length,latest_subject:l2?l2.subject:null},sent:{count:SENT_EMAILS.length}});}addEventListener("fetch",e=\u003e{e.respondWith(handleRequest(e.request));});async function handleRequest(request){const url=new URL(request.url);const method=request.method;if(method==="OPTIONS"){return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization"}});}try{if(method==="POST"\u0026\u0026url.pathname==="/webhook/resend-inbound"){const b=await request.json().catch(()=\u003e({}));return handleWebhook(b,PFP_INBOX);}if(method==="POST"\u0026\u0026url.pathname==="/webhook/resend-mobilemonero"){const b=await request.json().catch(()=\u003e({}));return handleWebhook(b,XMRT_INBOX);}if(method==="GET"\u0026\u0026url.pathname==="/health"){return jsonResponse({ok:true,service:"inbox",uptime:"∞",version:"1.0.0"});}if(method==="GET"\u0026\u0026url.pathname==="/inbox/brief"){return brief();}if(!check_auth(request))return auth_fail();if(method==="GET"\u0026\u0026(url.pathname==="/inbox/pfp"||url.pathname==="/inbox/pfp/")){return listInbox(PFP_INBOX,url);}if(method==="GET"\u0026\u0026(url.pathname==="/inbox/mobilemonero"||url.pathname==="/inbox/mobilemonero/")){return listInbox(XMRT_INBOX,url);}if(method==="GET"\u0026\u0026(url.pathname==="/sent"||url.pathname==="/sent/")){return listInbox(SENT_EMAILS,url);}if(method==="POST"\u0026\u0026url.pathname==="/sent"){const b=await request.json().catch(()=\u003e({}));SENT_EMAILS.unshift({id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),to:b.to||"",subject:b.subject||"",created_at:now(),raw:b});if(SENT_EMAILS.length\u003e2500)SENT_EMAILS.length=2500;return jsonResponse({ok:true,count:SENT_EMAILS.length});}if(method==="GET"\u0026\u0026url.pathname.startsWith("/inbox/pfp/")){const id=url.pathname.split("/").pop();const item=PFP_INBOX.find(e=\u003ee.id===id);return item?jsonResponse(item):jsonResponse({error:"not found"},404);}if(method==="GET"\u0026\u0026url.pathname.startsWith("/inbox/mobilemonero/")){const id=url.pathname.split("/").pop();const item=XMRT_INBOX.find(e=\u003ee.id===id);return item?jsonResponse(item):jsonResponse({error:"not found"},404);}return jsonResponse({error:"not found"},404);}catch(e){return jsonResponse({error:"Server error",detail:String(e)},500);}}
EOF
)

echo "Building payload..."
BODY64=$(echo -n "${SCRIPT}" | python3 -c "import sys,base64; print(base64.b64encode(sys.stdin.read().encode()).decode())")
PAYLOAD=$(python3 -c "import json; print(json.dumps({'metadata':{'main_module':'index.js'},'bindings':[],'part':'index.js','body':'${BODY64}'}))")

echo "Uploading inbox Worker..."
curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/inbox" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/javascript+base64" \
  -d "${PAYLOAD}"

echo ""
echo "Deploy done. Now adding route..."
# Route
python3 <<PYEOF
import json, subprocess, os
payload = json.dumps({"pattern": "inbox.mobilemonero.com/*", "script": "inbox", "zone_id": "8710927c035b113b585b1d09403f7034"})
cmd = [
  "curl", "-s", "-X", "POST",
  "https://api.cloudflare.com/client/v4/zones/8710927c035b113b585b1d09403f7034/workers/routes",
  "-H", f"Authorization: Bearer {os.environ.get('CF_API_TOKEN')}",
  "-H", "Content-Type: application/json",
  "-d", payload
]
print("Adding route...")
result = subprocess.run(cmd, capture_output=True, encoding="utf-8")
print(result.stdout)
if result.returncode != 0:
  print("STDERR:", result.stderr)
PYEOF