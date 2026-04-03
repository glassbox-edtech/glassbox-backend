import { corsHeaders, jsonError } from '../utils/helpers.js';
import { rebuildMasterRulesCache } from '../utils/cache.js';

export async function handleAdminRequest(request, env, ctx, url) {
    // 🔒 Enforce Admin Auth globally for this module
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
        return jsonError("Unauthorized", 401);
    }

    // ------------------------------------------------------------------
    // ROUTE: GET /api/admin/filter/requests (Admin UI viewing)
    // ------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/filter/requests") {
        const { results } = await env.DB.prepare(
            `SELECT id, student_hash, url, reason, created_at FROM unblock_requests WHERE status = 'pending' ORDER BY created_at DESC`
        ).all();
        
        return Response.json(results, { headers: corsHeaders });
    }

    // ------------------------------------------------------------------
    // ROUTE: POST /api/admin/filter/resolve (Admin UI approving)
    // ------------------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/filter/resolve") {
        const body = await request.json();
        const { requestId, action } = body;
        
        const rawTarget = body.target || body.domain;
        const matchType = body.matchType || 'domain';

        if (action === "approve") {
            const cleanTarget = rawTarget.toLowerCase();

            await env.DB.prepare(`UPDATE unblock_requests SET status = 'approved' WHERE id = ?`).bind(requestId).run();
            await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
            
            const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
            
            await env.DB.prepare(
                `UPDATE rules SET is_active = 0, version_removed = ? WHERE target = ? AND is_active = 1`
            ).bind(state.current_version, cleanTarget).run();

            await env.DB.prepare(
                `INSERT INTO rules (target, match_type, action, version_added) VALUES (?, ?, 'allow', ?)`
            ).bind(cleanTarget, matchType, state.current_version).run();

            // ⚡ Use the centralized cache manager to rebuild!
            await rebuildMasterRulesCache(env, ctx);

            return Response.json({ success: true, message: `Target ${cleanTarget} allowed.` }, { headers: corsHeaders });
        } else {
            await env.DB.prepare(`UPDATE unblock_requests SET status = 'denied' WHERE id = ?`).bind(requestId).run();
            return Response.json({ success: true, message: "Request denied." }, { headers: corsHeaders });
        }
    }

    // ------------------------------------------------------------------
    // ROUTE: POST /api/admin/filter/block (Admin UI manual blocking)
    // ------------------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/filter/block") {
        const body = await request.json();
        let blocksToProcess = [];

        if (Array.isArray(body.domains)) {
            blocksToProcess = body.domains.map(d => ({ target: d.toLowerCase(), matchType: 'domain' }));
        } else if (Array.isArray(body.blocks)) {
            blocksToProcess = body.blocks.map(b => ({ target: b.target.toLowerCase(), matchType: b.matchType || 'domain' }));
        } else {
            return jsonError("Invalid payload format", 400);
        }

        if (blocksToProcess.length === 0) {
            return jsonError("Empty blocks list", 400);
        }

        await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();

        const retireStmts = blocksToProcess.map(b => 
            env.DB.prepare(
                `UPDATE rules SET is_active = 0, version_removed = ? WHERE target = ? AND is_active = 1`
            ).bind(state.current_version, b.target)
        );

        const insertStmts = blocksToProcess.map(b => 
            env.DB.prepare(
                `INSERT INTO rules (target, match_type, action, version_added) VALUES (?, ?, 'block', ?)`
            ).bind(b.target, b.matchType, state.current_version)
        );

        await env.DB.batch([...retireStmts, ...insertStmts]);
        
        // ⚡ Use the centralized cache manager to rebuild!
        await rebuildMasterRulesCache(env, ctx);

        return Response.json({ success: true, message: `Blocked ${blocksToProcess.length} targets.` }, { headers: corsHeaders });
    }

    return null; // Hand back to router if no route matched
}