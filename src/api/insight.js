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
            // ⚠️ SECURITY CHECK: Ensure Cloudflare API credentials exist
            if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
                return jsonError("Cloudflare API credentials not configured on Worker.", 500);
            }

            // Extract filtering parameters from the URL
            const timeframe = url.searchParams.get("timeframe") || "30"; // Days, defaults to 30
            const studentHash = url.searchParams.get("studentHash") || null;
            const limit = parseInt(url.searchParams.get("limit")) || 50;
            const minMinutes = parseFloat(url.searchParams.get("minMinutes")) || 0;
            const maxMinutes = parseFloat(url.searchParams.get("maxMinutes")) || null;

            // 🚀 Querying Cloudflare Analytics Engine via the SQL API
            // blob1 = logType, blob2 = studentHash, blob3 = target, blob4 = isApprovedStr, double1 = value
            let query = `SELECT blob3 AS target, SUM(double1) AS total_minutes FROM glassbox_logs WHERE blob1 = 'time_log'`;

            // Filter by Date
            if (timeframe !== "all") {
                const days = parseInt(timeframe) || 30;
                query += ` AND timestamp >= NOW() - INTERVAL '${days}' DAY`;
            }

            // Filter by Student Hash
            if (studentHash) {
                // Ensure no SQL injection via hash format (alphanumeric check)
                const cleanHash = studentHash.replace(/[^a-fA-F0-9]/g, '');
                query += ` AND blob2 = '${cleanHash}'`;
            }

            // Group by the app/domain
            query += ` GROUP BY blob3 HAVING total_minutes >= ${minMinutes}`;

            // Filter by max time (if provided)
            if (maxMinutes !== null) {
                query += ` AND total_minutes <= ${maxMinutes}`;
            }

            // Finish the query by ordering and limiting
            query += ` ORDER BY total_minutes DESC LIMIT ${limit}`;

            // Execute the query against the Cloudflare API
            const cfApiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
            const cfResponse = await fetch(cfApiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.CF_API_TOKEN}`,
                    'Content-Type': 'application/x-sql'
                },
                body: query
            });

            const data = await cfResponse.json();

            // Check if the Cloudflare API request was successful
            if (!cfResponse.ok || !data.success) {
                console.error("Analytics Engine Query Error:", data.errors);
                throw new Error(data.errors?.[0]?.message || "Failed to query Analytics Engine.");
            }

            // Check if we actually have data
            if (!data.data || data.data.length === 0) {
                return Response.json({ message: "No analytics data matched these filters." }, { headers: corsHeaders });
            }

            // Format it nicely for the chart (round to 1 decimal place)
            const reports = data.data.map(row => ({
                target: row.target,
                total_minutes: Math.round(row.total_minutes * 10) / 10
            }));

            return Response.json({ reports: reports }, { headers: corsHeaders });
        } catch (err) {
            console.error("Admin Insight Report Error:", err);
            // Temporarily expose the real error string to the browser!
            return jsonError(`DEBUG: ${err.message}`, 500);
        }
    }

    // ---------------------------------------------------------
    // ROUTE: GET /api/admin/insight/traffic (Live URL Hit Data)
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/traffic") {
        try {
            if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
                return jsonError("Cloudflare API credentials not configured on Worker.", 500);
            }

            const timeframe = url.searchParams.get("timeframe") || "7"; // Default to 7 days for live traffic
            const limit = parseInt(url.searchParams.get("limit")) || 100;

            // Querying hit_logs. blob3 = target url, blob4 = status, double1 = hit counts
            let query = `SELECT blob3 AS target, blob4 AS status, SUM(double1) AS hits FROM glassbox_logs WHERE blob1 = 'hit_log'`;

            if (timeframe !== "all") {
                const days = parseInt(timeframe) || 7;
                query += ` AND timestamp >= NOW() - INTERVAL '${days}' DAY`;
            }

            query += ` GROUP BY blob3, blob4 ORDER BY hits DESC LIMIT ${limit}`;

            // Execute the query against the Cloudflare API
            const cfApiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID.trim()}/analytics_engine/sql`;
            const cfResponse = await fetch(cfApiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.CF_API_TOKEN.trim()}`,
                    'Content-Type': 'application/x-sql'
                },
                body: query
            });

            // FOOLPROOF DEBUG: Read the raw text first instead of assuming JSON
            const rawText = await cfResponse.text();
            
            if (!cfResponse.ok) {
                // This will spit the exact raw Cloudflare error to your dashboard!
                throw new Error(`HTTP ${cfResponse.status} - CF RAW: ${rawText}`);
            }

            const data = JSON.parse(rawText);

            if (!data.data || data.data.length === 0) {
                return Response.json({ traffic: [] }, { headers: corsHeaders });
            }

            return Response.json({ traffic: data.data }, { headers: corsHeaders });
        } catch (err) {
            console.error("Admin Insight Traffic Error:", err);
            // Temporarily expose the real error string to the browser!
            return jsonError(`DEBUG: ${err.message}`, 500);
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