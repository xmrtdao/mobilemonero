/**
 * ZKP Verification Stub Worker
 * Stub endpoints for transaction and balance proof verification.
 * Real verification WASM not yet compiled.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // POST /verify/tx
    if (url.pathname === "/verify/tx" && request.method === "POST") {
      try {
        const proof = await request.json();
        console.log("[stub] received tx proof:", JSON.stringify(proof));
        return new Response(
          JSON.stringify({ valid: false, note: "stub — real verification WASM not yet compiled" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // POST /verify/balance
    if (url.pathname === "/verify/balance" && request.method === "POST") {
      try {
        const proof = await request.json();
        console.log("[stub] received balance proof:", JSON.stringify(proof));
        return new Response(
          JSON.stringify({ valid: false, note: "stub — real verification WASM not yet compiled" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
