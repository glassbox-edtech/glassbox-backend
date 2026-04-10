import { corsHeaders, cacheHeaders, jsonError } from '../utils/helpers.js';

export async function handleInsightRequest(request, env, url) {

    // ---------------------------------------------------------
    // 🎒 ROUTE: GET /api/insight/sync
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/insight/sync") {
        try {
            // 🎯 FIX: Read the schoolId from the query parameters (defaults to 1)
            const schoolId = parseInt(url.searchParams.get("schoolId")) || 1;

            const { results: settings } = await env.DB.prepare(`SELECT setting_key, setting_value FROM system_settings`).all();
            const configObj = {};
            settings.forEach(s => configObj[s.setting_key] = s.setting_value);

            // 🎯 FIX: Fetch global approved apps (1) AND school-specific approved apps
            const { results: apps } = await env.DB.prepare(
                `SELECT domain FROM approved_apps WHERE school_id IN (1, ?)`
            ).bind(schoolId).all();
            const appDomains = apps.map(a => a.domain);

            return Response.json({
                config: configObj,
                approvedApps: appDomains
            }, { headers: cacheHeaders });
        } catch (err) {
            return jsonError("Failed to fetch insight config", 500);
        }
    }

    // ---------------------------------------------------------
    // 🎒 ROUTE: POST /api/insight/ingest
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/insight/ingest") {
        try {
            const body = await request.json();
            const { studentHash, logs } = body;

            if (!studentHash || !Array.isArray(logs)) {
                return jsonError("Invalid payload format", 400);
            }

            // 🎯 FIX: Look up the student's locked school ID on the fly
            const student = await env.DB.prepare(`SELECT school_id FROM students WHERE student_hash = ?`).bind(studentHash).first();
            const schoolId = student ? student.school_id : 1;

            const { results: apps } = await env.DB.prepare(
                `SELECT domain FROM approved_apps WHERE school_id IN (1, ?)`
            ).bind(schoolId).all();
            
            const approvedSet = new Set(apps.map(a => a.domain));

            let pointsWritten = 0;

            for (const log of logs) {
                const target = String(log.target).substring(0, 255);
                const value = Number(log.value) || 0;
                const logType = log.type === 'hit' ? 'hit_log' : 'time_log';
                
                const domainToCheck = logType === 'hit_log' ? target.split('/')[0] : target;
                const isApprovedStr = approvedSet.has(domainToCheck) ? "approved" : "unapproved";

                env.GLASSBOX_LOGS.writeDataPoint({
                    // 🎯 FIX: Injected String(schoolId) into blob5 so we can filter Hot Storage queries by campus!
                    blobs: [logType, studentHash, target, isApprovedStr, String(schoolId)], 
                    doubles: [value]
                });
                
                pointsWritten++;
            }

            return Response.json({ success: true, message: `Ingested ${pointsWritten} data points for school ${schoolId}.` }, { headers: corsHeaders });

        } catch (err) {
            console.error("Insight Ingest Error:", err);
            return jsonError("Failed to ingest logs", 500);
        }
    }

    return null;
}

// ------------------------------------------------------------------
// 🏛️ ADMIN-FACING INSIGHT ROUTES 
// ------------------------------------------------------------------
export async function handleAdminInsightRequest(request, env, ctx, url) {
    
    // 🎯 FIX: Extract scoped variables from the authenticated user object
    const adminSchoolId = request.user.school_id;
    const auditUserId = request.user.id === 0 ? null : request.user.id;

    const timeframeParam = url.searchParams.get("timeframe") || "7";
    const studentHash = url.searchParams.get("studentHash") || null;
    const limit = parseInt(url.searchParams.get("limit")) || 50;
    const statusFilter = url.searchParams.get("statusFilter") || "all";
    
    // We only use Warm Storage for macroscopic data (>7 days) AND if there is no specific student selected
    const useWarmStorage = !studentHash && (timeframeParam === "all" || parseInt(timeframeParam) > 7);

    // ---------------------------------------------------------
    // ROUTE: GET /api/admin/insight/reports 
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/reports") {
        try {
            const minMinutes = parseFloat(url.searchParams.get("minMinutes")) || 0;
            const maxMinutes = parseFloat(url.searchParams.get("maxMinutes")) || null;

            // 🗄️ ATTEMPT A: WARM STORAGE
            if (useWarmStorage && env.TELEMETRY_DB) {
                // 🎯 FIX: Hardcode the school_id scope
                let d1Query = `SELECT target, SUM(total_minutes) AS total_minutes, SUM(unique_students) AS unique_students FROM daily_rollups WHERE school_id = ${adminSchoolId}`;
                
                if (timeframeParam !== "all") {
                    const days = parseInt(timeframeParam) || 30;
                    d1Query += ` AND log_date >= date('now', '-${days} days')`;
                }

                if (statusFilter !== "all") {
                    const cleanStatus = statusFilter === 'approved' ? 'approved' : 'unapproved';
                    d1Query += ` AND status = '${cleanStatus}'`;
                }

                d1Query += ` GROUP BY target HAVING SUM(total_minutes) >= ${minMinutes}`;

                if (maxMinutes !== null) {
                    d1Query += ` AND SUM(total_minutes) <= ${maxMinutes}`;
                }

                d1Query += ` ORDER BY total_minutes DESC LIMIT ${limit}`;

                const { results } = await env.TELEMETRY_DB.prepare(d1Query).all();
                
                if (results && results.length > 0) {
                    const reports = results.map(row => ({
                        target: row.target,
                        total_minutes: Math.round(row.total_minutes * 10) / 10,
                        unique_students: row.unique_students || 1
                    }));
                    return Response.json({ reports: reports }, { headers: corsHeaders });
                }
            } 
            
            // 🔥 FALLBACK: HOT STORAGE (Cloudflare Analytics Engine)
            if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
                return jsonError("Cloudflare API credentials not configured on Worker.", 500);
            }

            // 🎯 FIX: Add blob5 filter to isolate traffic to this admin's school
            let query = `SELECT blob3 AS target, SUM(double1) AS total_minutes, COUNT(DISTINCT blob2) AS unique_students FROM glassbox_logs WHERE blob1 = 'time_log' AND blob5 = '${adminSchoolId}'`;

            if (timeframeParam !== "all") {
                const days = parseInt(timeframeParam) || 7;
                query += ` AND timestamp >= NOW() - INTERVAL '${days}' DAY`;
            }

            if (studentHash) {
                const cleanHash = studentHash.replace(/[^a-fA-F0-9]/g, '');
                query += ` AND blob2 = '${cleanHash}'`;
            }

            if (statusFilter !== "all") {
                const cleanStatus = statusFilter === 'approved' ? 'approved' : 'unapproved';
                query += ` AND blob4 = '${cleanStatus}'`;
            }

            query += ` GROUP BY blob3 HAVING SUM(double1) >= ${minMinutes}`;

            if (maxMinutes !== null) {
                query += ` AND SUM(double1) <= ${maxMinutes}`;
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
                total_minutes: Math.round(row.total_minutes * 10) / 10,
                unique_students: row.unique_students || 1
            }));

            return Response.json({ reports: reports }, { headers: corsHeaders });
            
        } catch (err) {
            console.error("Admin Insight Report Error:", err);
            return jsonError(`Report Error: ${err.message}`, 500);
        }
    }

    // ---------------------------------------------------------
    // 🚨 ROUTE: GET /api/admin/insight/outliers 
    // Hunts for individual students abusing the network (Density < 1, Time > High)
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/outliers") {
        try {
            if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
                return jsonError("Cloudflare API credentials not configured on Worker.", 500);
            }

            const outlierMinMinutes = parseFloat(url.searchParams.get("minMinutes")) || 60;
            const days = timeframeParam === "all" ? 30 : (parseInt(timeframeParam) || 7);

            // 🎯 FIX: Added blob5 filter to isolate outliers to this specific school
            let query = `
                SELECT 
                    blob2 AS student_hash, 
                    blob3 AS target, 
                    SUM(double1) AS total_minutes 
                FROM glassbox_logs 
                WHERE blob1 = 'time_log'
                  AND blob5 = '${adminSchoolId}'
                  AND timestamp >= NOW() - INTERVAL '${days}' DAY
            `;

            if (statusFilter !== "all") {
                const cleanStatus = statusFilter === 'approved' ? 'approved' : 'unapproved';
                query += ` AND blob4 = '${cleanStatus}'`;
            }

            query += ` GROUP BY blob2, blob3 HAVING SUM(double1) >= ${outlierMinMinutes} ORDER BY total_minutes DESC LIMIT ${limit}`;

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

            const outliers = (data.data || []).map(row => ({
                student_hash: row.student_hash,
                target: row.target,
                total_minutes: Math.round(row.total_minutes * 10) / 10
            }));

            return Response.json({ outliers: outliers }, { headers: corsHeaders });

        } catch (err) {
            console.error("Admin Insight Outliers Error:", err);
            return jsonError(`Outliers Error: ${err.message}`, 500);
        }
    }

    // ---------------------------------------------------------
    // ROUTE: GET /api/admin/insight/traffic
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/traffic") {
        try {
            // 🗄️ ATTEMPT A: WARM STORAGE
            if (useWarmStorage && env.TELEMETRY_DB) {
                // 🎯 FIX: Hardcode the school_id scope
                let d1Query = `SELECT target, status, SUM(total_hits) AS hits FROM daily_rollups WHERE school_id = ${adminSchoolId}`;
                
                if (timeframeParam !== "all") {
                    const days = parseInt(timeframeParam) || 30;
                    d1Query += ` AND log_date >= date('now', '-${days} days')`;
                }

                if (statusFilter !== "all") {
                    const cleanStatus = statusFilter === 'approved' ? 'approved' : 'unapproved';
                    d1Query += ` AND status = '${cleanStatus}'`;
                }

                d1Query += ` GROUP BY target, status ORDER BY hits DESC LIMIT ${limit}`;

                const { results } = await env.TELEMETRY_DB.prepare(d1Query).all();
                
                // Fallthrough if empty
                if (results && results.length > 0) {
                    return Response.json({ traffic: results }, { headers: corsHeaders });
                }
            }
            
            // 🔥 FALLBACK: HOT STORAGE 
            if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
                return jsonError("Cloudflare API credentials not configured on Worker.", 500);
            }

            // 🎯 FIX: Add blob5 filter to isolate traffic to this school
            let query = `SELECT blob3 AS target, blob4 AS status, SUM(double1) AS hits FROM glassbox_logs WHERE blob1 = 'hit_log' AND blob5 = '${adminSchoolId}'`;

            if (timeframeParam !== "all") {
                const days = parseInt(timeframeParam) || 7;
                query += ` AND timestamp >= NOW() - INTERVAL '${days}' DAY`;
            }
            
            if (statusFilter !== "all") {
                const cleanStatus = statusFilter === 'approved' ? 'approved' : 'unapproved';
                query += ` AND blob4 = '${cleanStatus}'`;
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
            
        } catch (err) {
            console.error("Admin Insight Traffic Error:", err);
            return jsonError(`Traffic Error: ${err.message}`, 500);
        }
    }

    // ---------------------------------------------------------
    // ROUTE: GET /api/admin/insight/apps 
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/insight/apps") {
        try {
            // 🎯 FIX: Only fetch apps that are globally approved (1) or approved by this school
            const { results } = await env.DB.prepare(
                `SELECT id, domain, app_name, category, created_at FROM approved_apps WHERE school_id IN (1, ?) ORDER BY domain ASC`
            ).bind(adminSchoolId).all();
            
            return Response.json({ apps: results }, { headers: corsHeaders });
        } catch (err) {
            console.error("List Apps Error:", err);
            return jsonError("Failed to load approved apps", 500);
        }
    }

    // ---------------------------------------------------------
    // ROUTE: POST /api/admin/insight/apps 
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/insight/apps") {
        try {
            const body = await request.json();
            const { action, domain, appName, category, id } = body;

            if (action === "add") {
                if (!domain || !appName) return jsonError("Domain and App Name are required.", 400);
                const cleanDomain = domain.toLowerCase().trim();
                const safeCategory = category || "General";

                // 🎯 FIX: Insert apps tagged to this specific school
                await env.DB.prepare(
                    `INSERT OR IGNORE INTO approved_apps (school_id, domain, app_name, category) VALUES (?, ?, ?, ?)`
                ).bind(adminSchoolId, cleanDomain, appName, safeCategory).run();

                // 📝 AUDIT LOGGING (Fire and Forget)
                ctx.waitUntil((async () => {
                    const settingsResult = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'enable_audit_logging'`).first();
                    if (settingsResult && settingsResult.setting_value === '1') {
                        await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, target) VALUES (?, 'add_approved_app', ?)`).bind(auditUserId, cleanDomain).run();
                    }
                })());

                return Response.json({ success: true, message: `Added ${appName} (${cleanDomain}) to approved list.` }, { headers: corsHeaders });
            } 
            else if (action === "remove") {
                // 🎯 FIX: Ensure they can only remove apps belonging to their school
                if (id) {
                    await env.DB.prepare(`DELETE FROM approved_apps WHERE id = ? AND school_id = ?`).bind(id, adminSchoolId).run();
                } else if (domain) {
                    await env.DB.prepare(`DELETE FROM approved_apps WHERE domain = ? AND school_id = ?`).bind(domain.toLowerCase(), adminSchoolId).run();
                } else {
                    return jsonError("Valid ID or Domain required for removal.", 400);
                }

                // 📝 AUDIT LOGGING (Fire and Forget)
                ctx.waitUntil((async () => {
                    const targetLog = id ? `app_id_${id}` : domain.toLowerCase();
                    const settingsResult = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'enable_audit_logging'`).first();
                    if (settingsResult && settingsResult.setting_value === '1') {
                        await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, target) VALUES (?, 'remove_approved_app', ?)`).bind(auditUserId, targetLog).run();
                    }
                })());

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