const corsHeaders = {
  "Access-Control-Allow-Origin": "*", 
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      // ------------------------------------------------------------------
      // ROUTE: POST /api/request (Student Submits Unblock Request)
      // ------------------------------------------------------------------
      if (request.method === "POST" && url.pathname === "/api/request") {
        const body = await request.json();
        const { studentHash, url: reqUrl, reason } = body;

        // 🛡️ SECURITY PATCH: Payload Size & Type Validation
        if (!reqUrl || typeof reqUrl !== 'string' || reqUrl.length > 500) {
          return Response.json({ error: "URL invalid or too long (max 500 chars)." }, { status: 400, headers: corsHeaders });
        }
        if (!reason || typeof reason !== 'string' || reason.length > 1000) {
          return Response.json({ error: "Reason invalid or too long (max 1000 chars)." }, { status: 400, headers: corsHeaders });
        }
        if (!studentHash || typeof studentHash !== 'string' || studentHash.length > 100) {
          return Response.json({ error: "Invalid identity hash." }, { status: 400, headers: corsHeaders });
        }

        await env.DB.prepare(
          `INSERT INTO unblock_requests (student_hash, url, reason) VALUES (?, ?, ?)`
        ).bind(studentHash, reqUrl, reason).run();

        return Response.json({ success: true, message: "Request pending" }, { headers: corsHeaders });
      }

      // ------------------------------------------------------------------
      // ROUTE: GET /api/sync?version=X (Extension Polls for Delta Updates)
      // ------------------------------------------------------------------
      if (request.method === "GET" && url.pathname === "/api/sync") {
        const clientVersion = parseInt(url.searchParams.get("version")) || 0;

        // 1. Get current server version
        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
        const serverVersion = state.current_version;

        // Condition 1: Up to date
        if (clientVersion === serverVersion) {
          return Response.json({ status: "up_to_date", version: serverVersion }, { headers: corsHeaders });
        }

        // Condition 2: Gap too large (Force Full Sync)
        if (clientVersion === 0 || serverVersion - clientVersion > 50) {
          return Response.json({ status: "full_sync_required", version: serverVersion }, { headers: corsHeaders });
        }

        // Condition 3: Delta Update (SQL handles the heavy lifting!)
        // 🔄 SCHEMA UPDATE: Now pulls 'target' and 'match_type' instead of 'domain'
        const { results } = await env.DB.prepare(
          `SELECT id, target, match_type, action, is_active FROM rules WHERE version_added > ? OR version_removed > ?`
        ).bind(clientVersion, clientVersion).all();

        const added = results.filter(r => r.is_active === 1);
        const removed = results.filter(r => r.is_active === 0).map(r => r.id);

        return Response.json({
          status: "delta_success",
          version: serverVersion,
          added: added,
          removed: removed
        }, { headers: corsHeaders });
      }

      // ------------------------------------------------------------------
      // ROUTE: GET /api/sync/full (Fallback for large gaps)
      // ------------------------------------------------------------------
      if (request.method === "GET" && url.pathname === "/api/sync/full") {
        // Try to get cached full state from KV
        let fullState = await env.GLASSBOX_KV.get("master_rules", { type: "json" });
        
        if (!fullState) {
          // If KV is empty, build it directly from D1
          const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
          // 🔄 SCHEMA UPDATE: Now pulls 'target' and 'match_type'
          const { results } = await env.DB.prepare(`SELECT id, target, match_type, action FROM rules WHERE is_active = 1`).all();
          
          fullState = { version: state.current_version, rules: results };
          
          // Cache it in KV for the next time!
          ctx.waitUntil(env.GLASSBOX_KV.put("master_rules", JSON.stringify(fullState)));
        }

        return Response.json({ status: "full_success", ...fullState }, { headers: corsHeaders });
      }

      // ------------------------------------------------------------------
      // ROUTE: GET /api/admin/requests (Admin UI viewing)
      // ------------------------------------------------------------------
      if (request.method === "GET" && url.pathname === "/api/admin/requests") {
        const authHeader = request.headers.get("Authorization");
        if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }

        const { results } = await env.DB.prepare(
          `SELECT id, student_hash, url, reason, created_at FROM unblock_requests WHERE status = 'pending' ORDER BY created_at DESC`
        ).all();
        
        return Response.json(results, { headers: corsHeaders });
      }

      // ------------------------------------------------------------------
      // ROUTE: POST /api/admin/resolve (Admin UI approving)
      // ------------------------------------------------------------------
      if (request.method === "POST" && url.pathname === "/api/admin/resolve") {
        const authHeader = request.headers.get("Authorization");
        if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }

        const body = await request.json();
        const { requestId, action } = body;
        
        // 🔄 Backwards compatibility: Accept 'domain' or 'target', default matchType to 'domain'
        const rawTarget = body.target || body.domain;
        const matchType = body.matchType || 'domain';

        if (action === "approve") {
          // Force lowercase to prevent case-sensitive ghost rules
          const cleanTarget = rawTarget.toLowerCase();

          // Step 1: Mark request as approved
          await env.DB.prepare(`UPDATE unblock_requests SET status = 'approved' WHERE id = ?`).bind(requestId).run();
          
          // Step 2: Increment server version
          await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
          const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
          
          // Step 3: Deactivate any existing rules for this exact target
          await env.DB.prepare(
            `UPDATE rules SET is_active = 0, version_removed = ? WHERE target = ? AND is_active = 1`
          ).bind(state.current_version, cleanTarget).run();

          // Step 4: Insert the new rule with match_type
          await env.DB.prepare(
            `INSERT INTO rules (target, match_type, action, version_added) VALUES (?, ?, 'allow', ?)`
          ).bind(cleanTarget, matchType, state.current_version).run();

          // Step 5: Clear KV Cache
          ctx.waitUntil(env.GLASSBOX_KV.delete("master_rules"));

          return Response.json({ success: true, message: `Target ${cleanTarget} allowed.` }, { headers: corsHeaders });
        } else {
          // Just deny it
          await env.DB.prepare(`UPDATE unblock_requests SET status = 'denied' WHERE id = ?`).bind(requestId).run();
          return Response.json({ success: true, message: "Request denied." }, { headers: corsHeaders });
        }
      }

      // ------------------------------------------------------------------
      // ROUTE: POST /api/admin/block (Admin UI manual blocking)
      // ------------------------------------------------------------------
      if (request.method === "POST" && url.pathname === "/api/admin/block") {
        const authHeader = request.headers.get("Authorization");
        if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }

        const body = await request.json();
        let blocksToProcess = [];

        // 🔄 Format bridging: Support legacy string arrays OR the new object format
        if (Array.isArray(body.domains)) {
          blocksToProcess = body.domains.map(d => ({ target: d.toLowerCase(), matchType: 'domain' }));
        } else if (Array.isArray(body.blocks)) {
          blocksToProcess = body.blocks.map(b => ({ target: b.target.toLowerCase(), matchType: b.matchType || 'domain' }));
        } else {
          return Response.json({ error: "Invalid payload format" }, { status: 400, headers: corsHeaders });
        }

        if (blocksToProcess.length === 0) {
          return Response.json({ error: "Empty blocks list" }, { status: 400, headers: corsHeaders });
        }

        // 1. Increment server version
        await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();

        // 2. Prepare statements to deactivate old rules for these targets
        const retireStmts = blocksToProcess.map(b => 
            env.DB.prepare(
                `UPDATE rules SET is_active = 0, version_removed = ? WHERE target = ? AND is_active = 1`
            ).bind(state.current_version, b.target)
        );

        // 3. Prepare batch inserts for the new rules with match_type
        const insertStmts = blocksToProcess.map(b => 
            env.DB.prepare(
                `INSERT INTO rules (target, match_type, action, version_added) VALUES (?, ?, 'block', ?)`
            ).bind(b.target, b.matchType, state.current_version)
        );

        // 4. Run all retirements AND insertions simultaneously
        await env.DB.batch([...retireStmts, ...insertStmts]);

        // 5. Clear KV Cache
        ctx.waitUntil(env.GLASSBOX_KV.delete("master_rules"));

        return Response.json({ success: true, message: `Blocked ${blocksToProcess.length} targets.` }, { headers: corsHeaders });
      }

      // 404 Route
      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (err) {
      console.error(err);
      return Response.json({ error: "Server Error", details: err.message }, { status: 500, headers: corsHeaders });
    }
  },

  // ------------------------------------------------------------------
  // CRON JOB: Automatically rebuilds KV cache in the background
  // ------------------------------------------------------------------
  async scheduled(event, env, ctx) {
    console.log("Cron triggered: Pre-warming KV Cache...");
    try {
      // 1. Get the absolute latest data from D1
      const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
      // 🔄 SCHEMA UPDATE: Now pulls 'target' and 'match_type'
      const { results } = await env.DB.prepare(`SELECT id, target, match_type, action FROM rules WHERE is_active = 1`).all();
      
      const fullState = { version: state.current_version, rules: results };
      
      // 2. Overwrite the old KV Cache with the fresh data
      await env.GLASSBOX_KV.put("master_rules", JSON.stringify(fullState));
      console.log(`✅ KV Cache successfully pre-warmed to version ${state.current_version}`);
    } catch (err) {
      console.error("❌ Cron failed to update KV cache:", err);
    }
  }
};