import { corsHeaders, cacheHeaders, jsonError } from '../utils/helpers.js';
import { rebuildMasterRulesCache } from '../utils/cache.js';
import webpush from 'web-push';

// ------------------------------------------------------------------
// 🎒 STUDENT-FACING FILTER ROUTES (No Auth Required)
// ------------------------------------------------------------------
export async function handleFilterRequest(request, env, url) {
    // ROUTE: POST /api/filter/request (Student Submits Unblock Request)
    if (request.method === "POST" && url.pathname === "/api/filter/request") {
        const body = await request.json();
        const { studentHash, url: reqUrl, reason } = body;

        if (!reqUrl || typeof reqUrl !== 'string' || reqUrl.length > 500) {
            return jsonError("URL invalid or too long (max 500 chars).", 400);
        }
        if (!reason || typeof reason !== 'string' || reason.length > 1000) {
            return jsonError("Reason invalid or too long (max 1000 chars).", 400);
        }
        if (!studentHash || typeof studentHash !== 'string' || studentHash.length > 100) {
            return jsonError("Invalid identity hash.", 400);
        }

        // Insert the request and grab the newly generated ID
        const insertResult = await env.DB.prepare(
            `INSERT INTO unblock_requests (student_hash, url, reason) VALUES (?, ?, ?) RETURNING id`
        ).bind(studentHash, reqUrl, reason).first();

        const requestId = insertResult ? insertResult.id : null;

        // 🔔 TRIGGER WEB PUSH NOTIFICATIONS
        if (requestId && env.VAPID_KEYS) {
            try {
                // Pre-calculate the match type so the Quick Action button knows how to resolve it
                let matchType = 'domain';
                let cleanUrl = reqUrl.replace(/^https?:\/\//, '').replace(/^www\./, '');
                if (cleanUrl.includes('/') && cleanUrl.split('/')[1] !== '') {
                    matchType = 'path';
                }

                const { results: subscriptions } = await env.DB.prepare(`SELECT * FROM admin_push_subscriptions`).all();
                
                if (subscriptions && subscriptions.length > 0) {
                    const payload = JSON.stringify({
                        requestId: requestId,
                        url: reqUrl,
                        reason: reason,
                        studentHash: studentHash,
                        matchType: matchType
                    });

                    // Dispatch notifications concurrently
                    const pushPromises = subscriptions.map(sub => sendWebPush(sub, payload, env.VAPID_KEYS));
                    await Promise.allSettled(pushPromises);
                }
            } catch (err) {
                console.error("Failed to process push notifications:", err);
            }
        }

        return Response.json({ success: true, message: "Request pending" }, { headers: corsHeaders });
    }

    // ROUTE: GET /api/filter/sync?version=X (Extension Polls for Delta Updates)
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

    // ROUTE: GET /api/filter/sync/full (Fallback for large gaps)
    if (request.method === "GET" && url.pathname === "/api/filter/sync/full") {
        let fullState = await env.GLASSBOX_KV.get("master_rules", { type: "json" });
        
        if (!fullState) {
            const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
            const { results } = await env.DB.prepare(`SELECT id, target, match_type, action FROM rules WHERE is_active = 1`).all();
            fullState = { version: state.current_version, rules: results };
        }

        return Response.json({ status: "full_success", ...fullState }, { headers: cacheHeaders });
    }

    return null;
}

// ------------------------------------------------------------------
// 🏛️ ADMIN-FACING FILTER ROUTES (Auth Handled by admin.js)
// ------------------------------------------------------------------
export async function handleAdminFilterRequest(request, env, ctx, url) {
    // ROUTE: GET /api/admin/filter/requests (Admin UI viewing)
    if (request.method === "GET" && url.pathname === "/api/admin/filter/requests") {
        const { results } = await env.DB.prepare(
            `SELECT id, student_hash, url, reason, created_at FROM unblock_requests WHERE status = 'pending' ORDER BY created_at DESC`
        ).all();
        
        return Response.json(results, { headers: corsHeaders });
    }

    // ---------------------------------------------------------
    // 📋 NEW ROUTE: GET /api/admin/filter/rules (Paginated Active Rules)
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/filter/rules") {
        const page = parseInt(url.searchParams.get("page")) || 1;
        const limit = parseInt(url.searchParams.get("limit")) || 10;
        const offset = (page - 1) * limit;

        const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM rules WHERE is_active = 1`).first();
        const total = countResult ? countResult.total : 0;

        const { results } = await env.DB.prepare(
            `SELECT id, target, match_type, action, version_added FROM rules WHERE is_active = 1 ORDER BY id DESC LIMIT ? OFFSET ?`
        ).bind(limit, offset).all();

        return Response.json({ rules: results, total, page, limit }, { headers: corsHeaders });
    }

    // ---------------------------------------------------------
    // 🗑️ NEW ROUTE: POST /api/admin/filter/rules/remove (Retire an active rule)
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/filter/rules/remove") {
        const body = await request.json();
        const { ruleId } = body;

        if (!ruleId) return jsonError("Rule ID is required.", 400);

        await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();

        // Safely retire the rule by marking it inactive and setting the version_removed tracker
        await env.DB.prepare(
            `UPDATE rules SET is_active = 0, version_removed = ? WHERE id = ? AND is_active = 1`
        ).bind(state.current_version, ruleId).run();

        // ⚡ Rebuild KV Cache immediately so extensions sync the removal
        await rebuildMasterRulesCache(env, ctx);

        return Response.json({ success: true, message: "Rule successfully retired." }, { headers: corsHeaders });
    }

    // ROUTE: POST /api/admin/filter/resolve (Admin UI approving)
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

            // ⚡ Rebuild KV Cache
            await rebuildMasterRulesCache(env, ctx);

            return Response.json({ success: true, message: `Target ${cleanTarget} allowed.` }, { headers: corsHeaders });
        } else {
            await env.DB.prepare(`UPDATE unblock_requests SET status = 'denied' WHERE id = ?`).bind(requestId).run();
            return Response.json({ success: true, message: "Request denied." }, { headers: corsHeaders });
        }
    }

    // ROUTE: POST /api/admin/filter/block (Admin UI manual blocking)
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
        
        // ⚡ Rebuild KV Cache
        await rebuildMasterRulesCache(env, ctx);

        return Response.json({ success: true, message: `Blocked ${blocksToProcess.length} targets.` }, { headers: corsHeaders });
    }

    return null;
}

// ------------------------------------------------------------------
// 🔔 HELPER: DISPATCH WEB PUSH NOTIFICATION
// ------------------------------------------------------------------
async function sendWebPush(subscription, payload, vapidKeysJson) {
    try {
        const keys = JSON.parse(vapidKeysJson);
        
        // Setup the VAPID details so the browser push server trusts the payload
        webpush.setVapidDetails(
            'mailto:admin@glassbox.local', 
            keys.publicKey, 
            keys.privateKey
        );
        
        // Reconstruct the subscription object exactly how web-push expects it
        const pushSubscription = {
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
            }
        };

        // Fire off the encrypted notification!
        await webpush.sendNotification(pushSubscription, payload);
        console.log(`✅ [Push Notification] Successfully dispatched to ${subscription.endpoint}`);

    } catch (err) {
        console.error("❌ Error dispatching push notification:", err);
    }
}