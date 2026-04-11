import { corsHeaders, cacheHeaders, jsonError } from '../utils/helpers.js';
import { rebuildMasterRulesCache } from '../utils/cache.js';
import { sendNativePush } from '../utils/push.js';

// ------------------------------------------------------------------
// 🎒 STUDENT-FACING FILTER ROUTES (No Auth Required)
// ------------------------------------------------------------------
export async function handleFilterRequest(request, env, url) {
    // ROUTE: POST /api/filter/request (Student Submits Unblock Request)
    if (request.method === "POST" && url.pathname === "/api/filter/request") {
        const body = await request.json();
        const { studentHash, url: reqUrl, reason } = body;

        if (!reqUrl || typeof reqUrl !== 'string' || reqUrl.length > 2048) return jsonError("URL invalid or too long (max 2048 chars).", 400);
        if (!reason || typeof reason !== 'string' || reason.length > 1000) return jsonError("Reason invalid or too long (max 1000 chars).", 400);
        if (!studentHash || typeof studentHash !== 'string' || studentHash.length > 100) return jsonError("Invalid identity hash.", 400);

        const student = await env.DB.prepare(`SELECT school_id FROM students WHERE student_hash = ?`).bind(studentHash).first();
        const schoolId = student ? student.school_id : 1;

        const insertResult = await env.DB.prepare(
            `INSERT INTO unblock_requests (school_id, student_hash, url, reason) VALUES (?, ?, ?, ?) RETURNING id`
        ).bind(schoolId, studentHash, reqUrl, reason).first();

        const requestId = insertResult ? insertResult.id : null;

        if (requestId && env.VAPID_KEYS) {
            try {
                let matchType = 'domain';
                let cleanUrl = reqUrl.replace(/^https?:\/\//, '').replace(/^www\./, '');
                if (cleanUrl.includes('/') && cleanUrl.split('/')[1] !== '') {
                    matchType = 'path';
                }

                const { results: subscriptions } = await env.DB.prepare(`SELECT * FROM admin_push_subscriptions WHERE school_id = ?`).bind(schoolId).all();
                
                if (subscriptions && subscriptions.length > 0) {
                    const payload = JSON.stringify({ requestId: requestId, url: reqUrl, reason: reason, studentHash: studentHash, matchType: matchType });
                    const pushPromises = subscriptions.map(sub => sendNativeWebPush(env, sub, payload, env.VAPID_KEYS));
                    await Promise.allSettled(pushPromises);
                }
            } catch (err) { console.error("Failed to process push notifications:", err); }
        }

        return Response.json({ success: true, message: "Request pending" }, { headers: corsHeaders });
    }

    // ROUTE: GET /api/filter/sync?version=X (Extension Polls for Delta Updates)
    if (request.method === "GET" && url.pathname === "/api/filter/sync") {
        const clientVersion = parseInt(url.searchParams.get("version")) || 0;
        const schoolId = parseInt(url.searchParams.get("schoolId")) || 1;
        const studentHash = url.searchParams.get("studentHash"); // 🎯 NEW

        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
        const serverVersion = state.current_version;

        if (clientVersion === serverVersion) {
            return Response.json({ status: "up_to_date", version: serverVersion }, { headers: cacheHeaders });
        }

        if (clientVersion === 0 || serverVersion - clientVersion > 50) {
            return Response.json({ status: "full_sync_required", version: serverVersion }, { headers: cacheHeaders });
        }

        let results = [];

        // 🎯 FIX: Safely JOIN classroom enrollments to pull custom teacher overrides
        if (studentHash) {
            const query = await env.DB.prepare(`
                SELECT r.id, r.target, r.match_type, r.action, r.is_active 
                FROM rules r
                LEFT JOIN classroom_students cs ON r.classroom_id = cs.classroom_id AND cs.student_hash = ?
                WHERE (r.version_added > ? OR r.version_removed > ?) 
                  AND r.school_id IN (1, ?)
                  AND (r.classroom_id IS NULL OR cs.classroom_id IS NOT NULL)
            `).bind(studentHash, clientVersion, clientVersion, schoolId).all();
            results = query.results;
        } else {
            // Fallback for unhashed agents
            const query = await env.DB.prepare(`
                SELECT id, target, match_type, action, is_active 
                FROM rules 
                WHERE (version_added > ? OR version_removed > ?) 
                  AND school_id IN (1, ?) 
                  AND classroom_id IS NULL
            `).bind(clientVersion, clientVersion, schoolId).all();
            results = query.results;
        }

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
        const schoolId = parseInt(url.searchParams.get("schoolId")) || 1;
        const studentHash = url.searchParams.get("studentHash"); // 🎯 NEW

        let fullState = await env.GLASSBOX_KV.get(`master_rules_${schoolId}`, { type: "json" });
        
        if (!fullState) {
            const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
            const { results } = await env.DB.prepare(`SELECT id, target, match_type, action, classroom_id FROM rules WHERE is_active = 1 AND school_id IN (1, ?)`).bind(schoolId).all();
            fullState = { version: state.current_version, rules: results };
        }

        // 🎯 FIX: Filter the KV cache JSON payload based on student's specific enrollments
        if (studentHash) {
            const { results: enrollments } = await env.DB.prepare(`SELECT classroom_id FROM classroom_students WHERE student_hash = ?`).bind(studentHash).all();
            const classIds = new Set(enrollments.map(e => e.classroom_id));
            
            // Keep rule if it has NO classroom_id (Global/School-wide) OR if it matches a class they are in
            fullState.rules = fullState.rules.filter(r => !r.classroom_id || classIds.has(r.classroom_id));
        } else {
            fullState.rules = fullState.rules.filter(r => !r.classroom_id);
        }

        return Response.json({ status: "full_success", ...fullState }, { headers: cacheHeaders });
    }

    return null;
}

// ------------------------------------------------------------------
// 🏛️ ADMIN-FACING FILTER ROUTES (Auth Handled by admin.js)
// ------------------------------------------------------------------
export async function handleAdminFilterRequest(request, env, ctx, url) {
    const adminSchoolId = request.user.school_id;
    const auditUserId = request.user.id === 0 ? null : request.user.id; 

    // ROUTE: GET /api/admin/filter/requests (Admin UI viewing)
    if (request.method === "GET" && url.pathname === "/api/admin/filter/requests") {
        const { results } = await env.DB.prepare(
            `SELECT id, student_hash, url, reason, created_at FROM unblock_requests WHERE status = 'pending' AND school_id = ? ORDER BY created_at DESC`
        ).bind(adminSchoolId).all();
        
        return Response.json(results, { headers: corsHeaders });
    }

    // ---------------------------------------------------------
    // 📋 ROUTE: GET /api/admin/filter/rules (Paginated Active Rules)
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/filter/rules") {
        const page = parseInt(url.searchParams.get("page")) || 1;
        const limit = parseInt(url.searchParams.get("limit")) || 10;
        const offset = (page - 1) * limit;

        // Note: Admin portal only shows school-wide rules (classroom_id IS NULL)
        const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM rules WHERE is_active = 1 AND school_id = ? AND classroom_id IS NULL`).bind(adminSchoolId).first();
        const total = countResult ? countResult.total : 0;

        const { results } = await env.DB.prepare(
            `SELECT id, target, match_type, action, version_added, expires_at FROM rules WHERE is_active = 1 AND school_id = ? AND classroom_id IS NULL ORDER BY id DESC LIMIT ? OFFSET ?`
        ).bind(adminSchoolId, limit, offset).all();

        return Response.json({ rules: results, total, page, limit }, { headers: corsHeaders });
    }

    // ---------------------------------------------------------
    // 🗑️ ROUTE: POST /api/admin/filter/rules/remove 
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/filter/rules/remove") {
        const body = await request.json();
        const { ruleId } = body;

        if (!ruleId) return jsonError("Rule ID is required.", 400);

        await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();

        await env.DB.prepare(
            `UPDATE rules SET is_active = 0, version_removed = ? WHERE id = ? AND is_active = 1 AND school_id = ?`
        ).bind(state.current_version, ruleId, adminSchoolId).run();

        await rebuildMasterRulesCache(env, ctx, adminSchoolId);

        ctx.waitUntil((async () => {
            const settingsResult = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'enable_audit_logging'`).first();
            if (settingsResult && settingsResult.setting_value === '1') {
                await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, target) VALUES (?, 'remove_rule', ?)`).bind(auditUserId, `rule_id_${ruleId}`).run();
            }
        })());

        return Response.json({ success: true, message: "Rule successfully retired." }, { headers: corsHeaders });
    }

    // ROUTE: POST /api/admin/filter/resolve (Admin UI approving)
    if (request.method === "POST" && url.pathname === "/api/admin/filter/resolve") {
        const body = await request.json();
        const { requestId, action, expiresInHours } = body;
        
        const rawTarget = body.target || body.domain;
        const matchType = body.matchType || 'domain';

        if (action === "approve") {
            const cleanTarget = rawTarget.toLowerCase();

            let expiresAt = null;
            if (expiresInHours && !isNaN(expiresInHours) && expiresInHours > 0) {
                expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString().replace('T', ' ').substring(0, 19);
            }

            await env.DB.prepare(`UPDATE unblock_requests SET status = 'approved' WHERE id = ? AND school_id = ?`).bind(requestId, adminSchoolId).run();
            await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
            
            const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
            
            await env.DB.prepare(
                `UPDATE rules SET is_active = 0, version_removed = ? WHERE target = ? AND is_active = 1 AND school_id = ? AND classroom_id IS NULL`
            ).bind(state.current_version, cleanTarget, adminSchoolId).run();

            await env.DB.prepare(
                `INSERT INTO rules (school_id, target, match_type, action, version_added, expires_at) VALUES (?, ?, ?, 'allow', ?, ?)`
            ).bind(adminSchoolId, cleanTarget, matchType, state.current_version, expiresAt).run();

            await rebuildMasterRulesCache(env, ctx, adminSchoolId);

            ctx.waitUntil((async () => {
                const settingsResult = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'enable_audit_logging'`).first();
                if (settingsResult && settingsResult.setting_value === '1') {
                    await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, target) VALUES (?, 'approve_request', ?)`).bind(auditUserId, cleanTarget).run();
                }
            })());

            return Response.json({ success: true, message: `Target ${cleanTarget} allowed.` }, { headers: corsHeaders });
        } else {
            await env.DB.prepare(`UPDATE unblock_requests SET status = 'denied' WHERE id = ? AND school_id = ?`).bind(requestId, adminSchoolId).run();
            
            ctx.waitUntil((async () => {
                const settingsResult = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'enable_audit_logging'`).first();
                if (settingsResult && settingsResult.setting_value === '1') {
                    await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, target) VALUES (?, 'deny_request', ?)`).bind(auditUserId, `request_id_${requestId}`).run();
                }
            })());

            return Response.json({ success: true, message: "Request denied." }, { headers: corsHeaders });
        }
    }

    // ROUTE: POST /api/admin/filter/block (Admin UI manual blocking)
    if (request.method === "POST" && url.pathname === "/api/admin/filter/block") {
        const body = await request.json();
        let blocksToProcess = [];
        const expiresInHours = body.expiresInHours;

        if (Array.isArray(body.domains)) {
            blocksToProcess = body.domains.map(d => ({ target: d.toLowerCase(), matchType: 'domain' }));
        } else if (Array.isArray(body.blocks)) {
            blocksToProcess = body.blocks.map(b => ({ target: b.target.toLowerCase(), matchType: b.matchType || 'domain' }));
        } else {
            return jsonError("Invalid payload format", 400);
        }

        if (blocksToProcess.length === 0) return jsonError("Empty blocks list", 400);
        
        let expiresAt = null;
        if (expiresInHours && !isNaN(expiresInHours) && expiresInHours > 0) {
            expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString().replace('T', ' ').substring(0, 19);
        }

        await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();

        const retireStmts = blocksToProcess.map(b => 
            env.DB.prepare(
                `UPDATE rules SET is_active = 0, version_removed = ? WHERE target = ? AND is_active = 1 AND school_id = ? AND classroom_id IS NULL`
            ).bind(state.current_version, b.target, adminSchoolId)
        );

        const insertStmts = blocksToProcess.map(b => 
            env.DB.prepare(
                `INSERT INTO rules (school_id, target, match_type, action, version_added, expires_at) VALUES (?, ?, ?, 'block', ?, ?)`
            ).bind(adminSchoolId, b.target, b.matchType, state.current_version, expiresAt)
        );

        await env.DB.batch([...retireStmts, ...insertStmts]);
        
        await rebuildMasterRulesCache(env, ctx, adminSchoolId);

        ctx.waitUntil((async () => {
            const settingsResult = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'enable_audit_logging'`).first();
            if (settingsResult && settingsResult.setting_value === '1') {
                const auditStmts = blocksToProcess.map(b => 
                    env.DB.prepare(`INSERT INTO audit_logs (user_id, action, target) VALUES (?, 'block_target', ?)`).bind(auditUserId, b.target)
                );
                await env.DB.batch(auditStmts);
            }
        })());

        return Response.json({ success: true, message: `Blocked ${blocksToProcess.length} targets.` }, { headers: corsHeaders });
    }

    return null;
}

// ------------------------------------------------------------------
// 🔔 HELPER: NATIVE WEB PUSH WRAPPER
// ------------------------------------------------------------------
async function sendNativeWebPush(env, subscription, payloadString, vapidKeysJson) {
    try {
        const formattedSubscription = {
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
            }
        };

        await sendNativePush(formattedSubscription, payloadString, vapidKeysJson);
        console.log(`✅ [Push Notification] Successfully dispatched encrypted payload to ${subscription.endpoint}`);
    } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
            console.warn(`🗑️ Subscription expired (HTTP ${err.statusCode}). Removing from database...`);
            try {
                await env.DB.prepare(`DELETE FROM admin_push_subscriptions WHERE endpoint = ?`).bind(subscription.endpoint).run();
            } catch (dbErr) {}
        } else {
            console.error("❌ Error dispatching push notification:", err);
        }
    }
}