import { corsHeaders, cacheHeaders, jsonError } from '../utils/helpers.js';

// ------------------------------------------------------------------
// 🎒 STUDENT-FACING INSIGHT ROUTES (No Auth Required)
// ------------------------------------------------------------------
export async function handleInsightRequest(request, env, url) {
    // ROUTE: GET /api/insight/sync (Extension downloads config & approved apps)
    if (request.method === "GET" && url.pathname === "/api/insight/sync") {
        try {
            // 1. Fetch Global Settings (like the time threshold)
            const { results: settings } = await env.DB.prepare(`SELECT setting_key, setting_value FROM system_settings`).all();
            
            // Convert array of key/value pairs into a simple config object
            const config = {};
            settings.forEach(s => {
                config[s.setting_key] = s.setting_value;
            });

            // 2. Fetch the Approved Apps list (just the domains)
            const { results: apps } = await env.DB.prepare(`SELECT domain FROM approved_apps`).all();
            const approvedDomains = apps.map(a => a.domain);

            // ⚡ APPLIED CACHE HEADERS: Absorb the 8:00 AM login rush!
            return Response.json({
                success: true,
                config: config,
                approvedApps: approvedDomains
            }, { headers: cacheHeaders });

        } catch (err) {
            console.error("Insight Sync Error:", err);
            return jsonError("Failed to sync insight config", 500);
        }
    }

    // ROUTE: POST /api/insight/ingest (Extension uploads batched time logs)
    if (request.method === "POST" && url.pathname === "/api/insight/ingest") {
        try {
            const body = await request.json();
            const { studentHash, logs } = body;

            // 🛡️ Basic Payload Validation
            if (!studentHash || typeof studentHash !== 'string') {
                return jsonError("Invalid student identity.", 400);
            }
            if (!Array.isArray(logs) || logs.length === 0) {
                return Response.json({ success: true, message: "No logs to process" }, { headers: corsHeaders });
            }

            // Cap the payload size to prevent abuse (e.g., max 500 logs per batch)
            const safeLogs = logs.slice(0, 500);

            // Fetch approved apps to cross-reference server-side (Double Verification)
            const { results: apps } = await env.DB.prepare(`SELECT domain FROM approved_apps`).all();
            const approvedSet = new Set(apps.map(a => a.domain));

            const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

            // Prepare batch statements for high-speed insertion
            const insertStmts = safeLogs.map(log => {
                // Ensure values are safe types
                const target = String(log.target).substring(0, 255);
                const minutes = Number(log.minutes) || 0;
                const isApproved = approvedSet.has(target) ? 1 : 0;

                return env.DB.prepare(
                    `INSERT INTO insight_logs (student_hash, target, minutes_spent, log_date, is_approved) 
                     VALUES (?, ?, ?, ?, ?)`
                ).bind(studentHash, target, minutes, today, isApproved);
            });

            // Execute all insertions in one atomic transaction
            await env.DB.batch(insertStmts);

            return Response.json({ success: true, message: `Ingested ${insertStmts.length} logs.` }, { headers: corsHeaders });

        } catch (err) {
            console.error("Insight Ingest Error:", err);
            return jsonError("Failed to ingest logs", 500);
        }
    }

    return null;
}

// ------------------------------------------------------------------
// 🏛️ ADMIN-FACING INSIGHT ROUTES (Auth Handled by admin.js)
// ------------------------------------------------------------------
export async function handleAdminInsightRequest(request, env, ctx, url) {
    // ROUTE: GET /api/admin/insight/reports
    if (request.method === "GET" && url.pathname === "/api/admin/insight/reports") {
        // Future logic to fetch ROI and time-tracking stats will go here!
        return Response.json({ message: "Insight reports coming soon!" }, { headers: corsHeaders });
    }

    return null;
}