import { corsHeaders, cacheHeaders, jsonError } from '../utils/helpers.js';

export async function handleFilterRequest(request, env, url) {
    // ------------------------------------------------------------------
    // ROUTE: POST /api/filter/request (Student Submits Unblock Request)
    // ------------------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/filter/request") {
        const body = await request.json();
        const { studentHash, url: reqUrl, reason } = body;

        // 🛡️ SECURITY PATCH: Payload Size & Type Validation
        if (!reqUrl || typeof reqUrl !== 'string' || reqUrl.length > 500) {
            return jsonError("URL invalid or too long (max 500 chars).", 400);
        }
        if (!reason || typeof reason !== 'string' || reason.length > 1000) {
            return jsonError("Reason invalid or too long (max 1000 chars).", 400);
        }
        if (!studentHash || typeof studentHash !== 'string' || studentHash.length > 100) {
            return jsonError("Invalid identity hash.", 400);
        }

        await env.DB.prepare(
            `INSERT INTO unblock_requests (student_hash, url, reason) VALUES (?, ?, ?)`
        ).bind(studentHash, reqUrl, reason).run();

        return Response.json({ success: true, message: "Request pending" }, { headers: corsHeaders });
    }

    // ------------------------------------------------------------------
    // ROUTE: GET /api/filter/sync?version=X (Extension Polls for Delta Updates)
    // ------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/filter/sync") {
        const clientVersion = parseInt(url.searchParams.get("version")) || 0;

        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
        const serverVersion = state.current_version;

        if (clientVersion === serverVersion) {
            return Response.json({ status: "up_to_date", version: serverVersion }, { headers: cacheHeaders });
        }

        if (clientVersion === 0 || serverVersion - clientVersion > 50) {
            return Response.json({ status: "full_sync_required", version: serverVersion }, { headers: cacheHeaders });
        }

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
        }, { headers: cacheHeaders });
    }

    // ------------------------------------------------------------------
    // ROUTE: GET /api/filter/sync/full (Fallback for large gaps)
    // ------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/filter/sync/full") {
        let fullState = await env.GLASSBOX_KV.get("master_rules", { type: "json" });
        
        if (!fullState) {
            // ⚡ RACE CONDITION FIXED: The student route is no longer allowed to 
            // write to the KV cache. It only reads from D1 if the cache is empty.
            const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
            const { results } = await env.DB.prepare(`SELECT id, target, match_type, action FROM rules WHERE is_active = 1`).all();
            
            fullState = { version: state.current_version, rules: results };
        }

        return Response.json({ status: "full_success", ...fullState }, { headers: cacheHeaders });
    }

    return null; // Hand back to router if no route matched
}