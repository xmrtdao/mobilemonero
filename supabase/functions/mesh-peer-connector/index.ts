import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

/**
 * mesh-peer-connector
 *
 * Discovery and registration service for the XMRT DAO Gossipsub mesh.
 * Agents register their peer ID, endpoints, and capabilities here so
 * new nodes can discover active peers and join the mesh.
 *
 * POST /functions/v1/mesh-peer-connector
 *
 * Actions:
 *   register   — Register or update an agent's mesh presence
 *   discover   — Get list of active peers for bootstrapping
 *   heartbeat  — Update agent's last-seen timestamp
 *   status     — Get mesh network summary
 *   unregister — Remove agent from the registry
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { action } = body;

  if (!action) {
    return new Response(JSON.stringify({ error: "action is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  switch (action) {
    // ── Register ──────────────────────────────────────
    case "register": {
      const { agent_name, peer_id, endpoint, topics, capabilities } = body;
      if (!agent_name || !peer_id) {
        return new Response(
          JSON.stringify({ error: "agent_name and peer_id are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data, error } = await supabase
        .from("mesh_peers")
        .upsert({
          agent_name,
          peer_id,
          endpoint: endpoint || null,
          topics: topics || ["agent-heartbeat", "agent-tasks", "agent-discovery", "fleet-broadcast"],
          capabilities: capabilities || [],
          last_seen: new Date().toISOString(),
          status: "online",
        }, { onConflict: "peer_id" })
        .select()
        .single();

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, peer: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Discover ──────────────────────────────────────
    case "discover": {
      const { data, error } = await supabase
        .from("mesh_peers")
        .select("*")
        .eq("status", "online")
        .gte("last_seen", new Date(Date.now() - 5 * 60 * 1000).toISOString()) // last 5 min
        .order("last_seen", { ascending: false });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, peers: data || [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Heartbeat ─────────────────────────────────────
    case "heartbeat": {
      const { peer_id, status } = body;
      if (!peer_id) {
        return new Response(JSON.stringify({ error: "peer_id is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error } = await supabase
        .from("mesh_peers")
        .update({
          last_seen: new Date().toISOString(),
          status: status || "online",
        })
        .eq("peer_id", peer_id);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Status ────────────────────────────────────────
    case "status": {
      const [peerCount, onlineCount] = await Promise.all([
        supabase.from("mesh_peers").select("*", { count: "exact", head: true }),
        supabase.from("mesh_peers").select("*", { count: "exact", head: true }).eq("status", "online").gte(
          "last_seen",
          new Date(Date.now() - 5 * 60 * 1000).toISOString()
        ),
      ]);

      return new Response(
        JSON.stringify({
          ok: true,
          total_peers: peerCount.count || 0,
          online_now: onlineCount.count || 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Unregister ────────────────────────────────────
    case "unregister": {
      const { peer_id } = body;
      if (!peer_id) {
        return new Response(JSON.stringify({ error: "peer_id is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error } = await supabase
        .from("mesh_peers")
        .update({ status: "offline", last_seen: new Date().toISOString() })
        .eq("peer_id", peer_id);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    default:
      return new Response(
        JSON.stringify({
          error: `Unknown action: ${action}`,
          valid_actions: ["register", "discover", "heartbeat", "status", "unregister"],
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
  }
});
