/**
 * Hermes Fleet Relay Worker — Hybrid (relay primary, memory fallback)
 *
 * Writes: forward to relay (persistent) + keep in memory (fast reads)
 * Reads: query relay first, fallback to Worker memory if relay down
 * If relay goes down, Worker accumulates messages until relay recovers
 *
 * Endpoints:
 *   GET    /health
 *   GET    /fleet/messages?limit=&offset=
 *   GET    /fleet/status
 *   POST   /fleet/broadcast          {from, message, type}
 *   POST   /from/:agent               {from, to, message, type}
 *   GET    /from/hermes?limit=&offset=
 *   GET    /from/hermes/:agent?limit=&offset=
 *
 * Relay: relay.mobilemonero.com (persistent Eliza-Dev server)
 */

const RELAY_URL = "https://relay.mobilemonero.com";

let RELAY_UP    = false;
let LAST_RELAY_CHECK = 0;
let MESSAGES    = [];
let AGENTS      = {};

function ts()  { return new Date().toISOString(); }
function jr(o,s){return new Response(JSON.stringify(o),{status:s||200,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});}

async function checkRelay(force=false){
  const now=Date.now();
  if(!force && now-LAST_RELAY_CHECK<30000 && RELAY_UP) return true;  // cache 30s
  try{
    const r=await fetch(`${RELAY_URL}/health`,{cf:{cacheTtl:0}});
    RELAY_UP = r.ok;
  }catch(e){ RELAY_UP=false; }
  LAST_RELAY_CHECK=now;
  return RELAY_UP;
}

async function proxyOrRelay(path, opts, useRelay){
  useRelay = useRelay && await checkRelay();
  if(useRelay){
    try{
      const r=await fetch(`${RELAY_URL}${path}`, opts);
      return r;
    }catch(e){ console.log("[hermes] relay fail",e.message); }
  }
  return null;
}

async function handle(req, event){
  const url=new URL(req.url), method=req.method;
  if(method==="OPTIONS") return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization"}});

  try{
    // Health
    if(method==="GET" && url.pathname==="/health"){
      let ok=false; try{ await checkRelay(); ok=RELAY_UP; }catch(e){}
      return jr({ok:true,service:"hermes",relay_up:ok,messages:MESSAGES.length,version:"3.0.2"});
    }

    // GET /fleet/status
    if(method==="GET" && url.pathname==="/fleet/status"){
      return jr({relay:"hermes-hybrid", agents:AGENTS, messages:MESSAGES.length, relay_up:RELAY_UP});
    }

    // GET /fleet/messages
    if(method==="GET" && url.pathname==="/fleet/messages"){
      const r=await proxyOrRelay("/api/fleet-chat/messages"+url.search, null, true);
      if(r && r.ok) return r;
      const L=Math.min(parseInt(url.searchParams.get("limit")||"50"),200), O=parseInt(url.searchParams.get("offset")||"0");
      return jr({total:MESSAGES.length,limit:L,offset:O,messages:MESSAGES.slice(O,O+L),source:"worker-memory"});
    }

    // POST /fleet/broadcast
    if(method==="POST" && url.pathname==="/fleet/broadcast"){
      const b=await req.json().catch(()=>{});
      const msg={msg_id:MESSAGES.length+1,from:b.from||"anonymous",message:b.message||"",ts:ts(),type:b.type||"broadcast"};
      MESSAGES.unshift(msg);
      if(MESSAGES.length>2000) MESSAGES.length=2000;
      event.waitUntil(sendToRelay(null, msg, "broadcast"));
      return jr({ok:true,logged:true,msg_id:msg.msg_id,relay:RELAY_UP});
    }

    // POST /from/:agent (DM)
    if(method==="POST" && url.pathname.startsWith("/from/")){
      const b=await req.json().catch(()=>{});
      const msg={msg_id:MESSAGES.length+1,from:b.from||"anonymous",to:b.to,message:b.message||"",ts:ts(),type:b.type||"dm"};
      MESSAGES.unshift(msg);
      if(MESSAGES.length>2000) MESSAGES.length=2000;
      event.waitUntil(sendToRelay(null, msg, "dm"));
      return jr({ok:true,logged:true,msg_id:msg.msg_id,relay:RELAY_UP});
    }

    // GET /from/hermes (all DMs through this agent)
    if(method==="GET" && url.pathname==="/from/hermes"){
      const r=await proxyOrRelay(url.pathname+url.search, null, true);
      if(r && r.ok) return r;
      const L=Math.min(parseInt(url.searchParams.get("limit")||"50"),200), O=parseInt(url.searchParams.get("offset")||"0");
      return jr({total:MESSAGES.length,messages:MESSAGES.slice(O,O+L),source:"worker-memory"});
    }

    // GET /from/hermes/:agent
    if(method==="GET" && url.pathname.startsWith("/from/hermes/")){
      const agent=url.pathname.split("/")[2];
      const r=await proxyOrRelay(url.pathname+url.search, null, true);
      if(r && r.ok) return r;
      const L=Math.min(parseInt(url.searchParams.get("limit")||"50"),200);
      const msgs=MESSAGES.filter(m=>m.from===agent).slice(0,L);
      return jr({total:msgs.length,agent:agent,messages:msgs,source:"worker-memory"});
    }

    return jr({error:"not found"},404);
  }catch(e){ return jr({error:"Server error",detail:String(e)},500); }
}

async function sendToRelay(path, msg, type){
  try{
    let body = msg;
    let urlPath = path;
    // Broadcast: use fleet-chat/send with agent/message/channel
    if(type === "broadcast"){
      urlPath = "/api/fleet-chat/send";
      body = { agent: msg.from || "hermes", message: msg.message || "", channel: "all" };
    }
    // DM: also use fleet-chat/send with channel=target
    else if(type === "dm"){
      urlPath = "/api/fleet-chat/send";
      body = { agent: msg.from || "hermes", message: msg.message || "", channel: msg.to || "fleet" };
    }
    const r=await fetch(`${RELAY_URL}${urlPath}`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body)
    });
    if(r.ok) console.log("[hermes] relay OK", urlPath, body.agent);
    else {
      const txt=await r.text().catch(()=>"");
      console.log("[hermes] relay HTTP", r.status, txt.slice(0,200));
    }
  }catch(e){ console.log("[hermes] relay err", e.message); }
}

addEventListener("fetch", event=>{
  event.respondWith(handle(event.request, event));
});
