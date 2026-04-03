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
    // ---------------------------------------------------------
    // ROUTE: GET /api/admin/insight/reports (Advanced Graphing Data)
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/reports") {
        try {
            // Extract filtering parameters from the URL
            const timeframe = url.searchParams.get("timeframe") || "30"; // Days, defaults to 30
            const studentHash = url.searchParams.get("studentHash") || null;
            const limit = parseInt(url.searchParams.get("limit")) || 50;
            const minMinutes = parseFloat(url.searchParams.get("minMinutes")) || 0;
            const maxMinutes = parseFloat(url.searchParams.get("maxMinutes")) || null;

            // Start building the dynamic SQL query
            let query = `SELECT target, SUM(minutes_spent) as total_minutes FROM insight_logs WHERE 1=1`;
            const bindParams = [];

            // Filter by Date
            if (timeframe !== "all") {
                const days = parseInt(timeframe) || 30;
                query += ` AND log_date >= date('now', ?)`;
                bindParams.push(`-${days} days`);
            }

            // Filter by Student Hash
            if (studentHash) {
                query += ` AND student_hash = ?`;
                bindParams.push(studentHash);
            }

            // Group by the app/domain
            query += ` GROUP BY target HAVING total_minutes >= ?`;
            bindParams.push(minMinutes);

            // Filter by max time (if provided)
            if (maxMinutes !== null) {
                query += ` AND total_minutes <= ?`;
                bindParams.push(maxMinutes);
            }

            // Finish the query by ordering and limiting
            query += ` ORDER BY total_minutes DESC LIMIT ?`;
            bindParams.push(limit);

            // Execute the dynamic query
            const { results } = await env.DB.prepare(query).bind(...bindParams).all();

            // Check if we actually have data
            if (!results || results.length === 0) {
                return Response.json({ message: "No analytics data matched these filters." }, { headers: corsHeaders });
            }

            // Format it nicely for the chart (round to 1 decimal place)
            const reports = results.map(row => ({
                target: row.target,
                total_minutes: Math.round(row.total_minutes * 10) / 10
            }));

            return Response.json({ reports: reports }, { headers: corsHeaders });
        } catch (err) {
            console.error("Admin Insight Report Error:", err);
            return jsonError("Failed to generate insight reports", 500);
        }
    }

    // ---------------------------------------------------------
    // ROUTE: GET /api/admin/insight/apps (List Approved Apps)
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/apps") {
        try {
            const { results } = await env.DB.prepare(
                `SELECT id, domain, app_name, category, created_at FROM approved_apps ORDER BY domain ASC`
            ).all();
            
            return Response.json({ apps: results }, { headers: corsHeaders });
        } catch (err) {
            console.error("List Apps Error:", err);
            return jsonError("Failed to load approved apps", 500);
        }
    }

    // ---------------------------------------------------------
    // ROUTE: POST /api/admin/insight/apps (Add/Remove Approved Apps)
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/insight/apps") {
        try {
            const body = await request.json();
            const { action, domain, appName, category, id } = body;

            if (action === "add") {
                if (!domain || !appName) {
                    return jsonError("Domain and App Name are required.", 400);
                }
                const cleanDomain = domain.toLowerCase().trim();
                const safeCategory = category || "General";

                // INSERT OR IGNORE prevents a crash if they try to add a duplicate domain
                await env.DB.prepare(
                    `INSERT OR IGNORE INTO approved_apps (domain, app_name, category) VALUES (?, ?, ?)`
                ).bind(cleanDomain, appName, safeCategory).run();

                return Response.json({ success: true, message: `Added ${appName} (${cleanDomain}) to approved list.` }, { headers: corsHeaders });
            } 
            
            else if (action === "remove") {
                if (id) {
                    await env.DB.prepare(`DELETE FROM approved_apps WHERE id = ?`).bind(id).run();
                } else if (domain) {
                    await env.DB.prepare(`DELETE FROM approved_apps WHERE domain = ?`).bind(domain.toLowerCase()).run();
                } else {
                    return jsonError("Valid ID or Domain required for removal.", 400);
                }
                
                return Response.json({ success: true, message: "App removed from approved list." }, { headers: corsHeaders });
            }

            return jsonError("Invalid action type.", 400);
        } catch (err) {
            console.error("Modify Apps Error:", err);
            return jsonError("Failed to modify approved apps", 500);
        }
    }

    return null; // Route missed
}