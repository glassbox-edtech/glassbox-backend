import { corsHeaders, cacheHeaders, jsonError } from '../utils/helpers.js';

export async function handleInsightRequest(request, env, url) {

    // ROUTE: GET /api/insight/sync (Extension polls for config)
    if (request.method === "GET" && url.pathname === "/api/insight/sync") {
        try {
            // Fetch system config and approved app list
            const { results: settings } = await env.DB.prepare(`SELECT setting_key, setting_value FROM system_settings`).all();
            const configObj = {};
            settings.forEach(s => configObj[s.setting_key] = s.setting_value);

            const { results: apps } = await env.DB.prepare(`SELECT domain FROM approved_apps`).all();
            const appDomains = apps.map(a => a.domain);

            return Response.json({
                config: configObj,
                approvedApps: appDomains
            }, { headers: cacheHeaders });
        } catch (err) {
            return jsonError("Failed to fetch insight config", 500);
        }
    }

    // ROUTE: POST /api/insight/ingest (Extension uploads chunked telemetry)
    if (request.method === "POST" && url.pathname === "/api/insight/ingest") {
        try {
            const body = await request.json();
            const { studentHash, logs } = body;

            if (!studentHash || !Array.isArray(logs)) {
                return jsonError("Invalid payload format", 400);
            }

            // Fetch approved apps for server-side verification
            const { results: apps } = await env.DB.prepare(`SELECT domain FROM approved_apps`).all();
            const approvedSet = new Set(apps.map(a => a.domain));

            let pointsWritten = 0;

            for (const log of logs) {
                // Ensure target is safe length
                const target = String(log.target).substring(0, 255);
                const value = Number(log.value) || 0;
                const logType = log.type === 'hit' ? 'hit_log' : 'time_log';
                
                // For hit logs, extract the root domain from the path to check approval status
                const domainToCheck = logType === 'hit_log' ? target.split('/')[0] : target;
                const isApprovedStr = approvedSet.has(domainToCheck) ? "approved" : "unapproved";

                // 🚀 Firehose telemetry into Cloudflare Analytics Engine
                // format: blobs: [LogType, StudentHash, TargetUrl, ApprovedStatus]
                // format: doubles: [MetricValue (minutes or hits)]
                env.GLASSBOX_LOGS.writeDataPoint({
                    blobs: [logType, studentHash, target, isApprovedStr], 
                    doubles: [value]
                });
                
                pointsWritten++;
            }

            return Response.json({ success: true, message: `Ingested ${pointsWritten} data points.` }, { headers: corsHeaders });

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
            // ⚠️ ARCHITECTURE NOTE: This will be refactored to query Cloudflare Analytics Engine GraphQL API
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