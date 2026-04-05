import { corsHeaders, cacheHeaders, jsonError } from '../utils/helpers.js';

export async function handleInsightRequest(request, env, url) {

    // ROUTE: GET /api/insight/sync (Extension polls for config)
    if (request.method === "GET" && url.pathname === "/api/insight/sync") {
        try {
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

            const { results: apps } = await env.DB.prepare(`SELECT domain FROM approved_apps`).all();
            const approvedSet = new Set(apps.map(a => a.domain));

            let pointsWritten = 0;

            for (const log of logs) {
                const target = String(log.target).substring(0, 255);
                const value = Number(log.value) || 0;
                const logType = log.type === 'hit' ? 'hit_log' : 'time_log';
                
                const domainToCheck = logType === 'hit_log' ? target.split('/')[0] : target;
                const isApprovedStr = approvedSet.has(domainToCheck) ? "approved" : "unapproved";

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
    
    // Helper variable to determine if we should route to Warm Storage
    const timeframeParam = url.searchParams.get("timeframe") || "7";
    const useWarmStorage = timeframeParam === "all" || parseInt(timeframeParam) > 7;

    // ---------------------------------------------------------
    // ROUTE: GET /api/admin/insight/reports (Advanced Graphing Data)
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/reports") {
        try {
            const studentHash = url.searchParams.get("studentHash") || null;
            const limit = parseInt(url.searchParams.get("limit")) || 50;
            const minMinutes = parseFloat(url.searchParams.get("minMinutes")) || 0;
            const maxMinutes = parseFloat(url.searchParams.get("maxMinutes")) || null;

            // 🗄️ ROUTE A: WARM STORAGE (D1 Telemetry Rollups)
            if (useWarmStorage && env.TELEMETRY_DB) {
                let d1Query = `SELECT target, SUM(total_minutes) AS total_minutes FROM daily_rollups WHERE 1=1`;
                const params = [];

                if (timeframeParam !== "all") {
                    const days = parseInt(timeframeParam) || 30;
                    d1Query += ` AND log_date >= date('now', '-${days} days')`;
                }

                if (studentHash) {
                    d1Query += ` AND student_hash = ?`;
                    params.push(studentHash.replace(/[^a-fA-F0-9]/g, ''));
                }

                d1Query += ` GROUP BY target HAVING total_minutes >= ${minMinutes}`;

                if (maxMinutes !== null) {
                    d1Query += ` AND total_minutes <= ${maxMinutes}`;
                }

                d1Query += ` ORDER BY total_minutes DESC LIMIT ${limit}`;

                const { results } = await env.TELEMETRY_DB.prepare(d1Query).bind(...params).all();
                
                const reports = results.map(row => ({
                    target: row.target,
                    total_minutes: Math.round(row.total_minutes * 10) / 10
                }));

                return Response.json({ reports: reports }, { headers: corsHeaders });
            } 
            
            // 🔥 ROUTE B: HOT STORAGE (Cloudflare Analytics Engine)
            else {
                if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
                    return jsonError("Cloudflare API credentials not configured on Worker.", 500);
                }

                let query = `SELECT blob3 AS target, SUM(double1) AS total_minutes FROM glassbox_logs WHERE blob1 = 'time_log'`;

                if (timeframeParam !== "all") {
                    const days = parseInt(timeframeParam) || 7;
                    query += ` AND timestamp >= NOW() - INTERVAL '${days}' DAY`;
                }

                if (studentHash) {
                    const cleanHash = studentHash.replace(/[^a-fA-F0-9]/g, '');
                    query += ` AND blob2 = '${cleanHash}'`;
                }

                query += ` GROUP BY blob3 HAVING total_minutes >= ${minMinutes}`;

                if (maxMinutes !== null) {
                    query += ` AND total_minutes <= ${maxMinutes}`;
                }

                query += ` ORDER BY total_minutes DESC LIMIT ${limit}`;

                const cfApiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID.trim()}/analytics_engine/sql`;
                const cfResponse = await fetch(cfApiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.CF_API_TOKEN.trim()}`,
                        'Content-Type': 'application/x-sql'
                    },
                    body: query
                });

                if (!cfResponse.ok) throw new Error(`HTTP ${cfResponse.status}: ${await cfResponse.text()}`);
                const data = await cfResponse.json();

                if (!data.data || data.data.length === 0) {
                    return Response.json({ reports: [] }, { headers: corsHeaders });
                }

                const reports = data.data.map(row => ({
                    target: row.target,
                    total_minutes: Math.round(row.total_minutes * 10) / 10
                }));

                return Response.json({ reports: reports }, { headers: corsHeaders });
            }
        } catch (err) {
            console.error("Admin Insight Report Error:", err);
            return jsonError(`Report Error: ${err.message}`, 500);
        }
    }

    // ---------------------------------------------------------
    // ROUTE: GET /api/admin/insight/traffic (Live URL Hit Data)
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/traffic") {
        try {
            const limit = parseInt(url.searchParams.get("limit")) || 100;

            // 🗄️ ROUTE A: WARM STORAGE (D1 Telemetry Rollups)
            if (useWarmStorage && env.TELEMETRY_DB) {
                let d1Query = `SELECT target, status, SUM(total_hits) AS hits FROM daily_rollups WHERE 1=1`;
                
                if (timeframeParam !== "all") {
                    const days = parseInt(timeframeParam) || 30;
                    d1Query += ` AND log_date >= date('now', '-${days} days')`;
                }

                d1Query += ` GROUP BY target, status ORDER BY hits DESC LIMIT ${limit}`;

                const { results } = await env.TELEMETRY_DB.prepare(d1Query).all();
                
                return Response.json({ traffic: results }, { headers: corsHeaders });
            }
            
            // 🔥 ROUTE B: HOT STORAGE (Cloudflare Analytics Engine)
            else {
                if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
                    return jsonError("Cloudflare API credentials not configured on Worker.", 500);
                }

                let query = `SELECT blob3 AS target, blob4 AS status, SUM(double1) AS hits FROM glassbox_logs WHERE blob1 = 'hit_log'`;

                if (timeframeParam !== "all") {
                    const days = parseInt(timeframeParam) || 7;
                    query += ` AND timestamp >= NOW() - INTERVAL '${days}' DAY`;
                }

                query += ` GROUP BY blob3, blob4 ORDER BY hits DESC LIMIT ${limit}`;

                const cfApiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID.trim()}/analytics_engine/sql`;
                const cfResponse = await fetch(cfApiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.CF_API_TOKEN.trim()}`,
                        'Content-Type': 'application/x-sql'
                    },
                    body: query
                });

                if (!cfResponse.ok) throw new Error(`HTTP ${cfResponse.status}: ${await cfResponse.text()}`);
                const data = await cfResponse.json();

                if (!data.data || data.data.length === 0) {
                    return Response.json({ traffic: [] }, { headers: corsHeaders });
                }

                return Response.json({ traffic: data.data }, { headers: corsHeaders });
            }
        } catch (err) {
            console.error("Admin Insight Traffic Error:", err);
            return jsonError(`Traffic Error: ${err.message}`, 500);
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

    return null; 
}