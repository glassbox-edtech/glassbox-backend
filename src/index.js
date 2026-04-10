import { corsHeaders } from './utils/helpers.js';
import { rebuildMasterRulesCache } from './utils/cache.js';
import { handleApiRequest } from './api.js';

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);

        try {
            if (url.pathname.startsWith("/api/")) {
                const response = await handleApiRequest(request, env, ctx, url);
                if (response) return response;
            }

            return new Response("Not Found", { status: 404, headers: corsHeaders });

        } catch (err) {
            console.error("Global Request Error:", err);
            return Response.json(
                { error: "Server Error", details: err.message }, 
                { status: 500, headers: corsHeaders }
            );
        }
    },

    async scheduled(event, env, ctx) {
        console.log(`Cron triggered for interval: ${event.cron}`);

        if (event.cron === "*/15 * * * *") {
            try {
                console.log("Running routine database maintenance and expiration checks...");
                
                // ==========================================
                // ⏱️ 1. THE REAPER: Check for Expired Rules
                // ==========================================
                const expiredCheck = await env.DB.prepare(
                    `SELECT id FROM rules WHERE is_active = 1 AND expires_at < CURRENT_TIMESTAMP`
                ).all();

                if (expiredCheck.results && expiredCheck.results.length > 0) {
                    console.log(`Found ${expiredCheck.results.length} expired rules. Retiring them...`);
                    
                    // Bump system version
                    await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
                    const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();

                    // Safely retire the expired rules
                    await env.DB.prepare(
                        `UPDATE rules SET is_active = 0, version_removed = ? WHERE is_active = 1 AND expires_at < CURRENT_TIMESTAMP`
                    ).bind(state.current_version).run();
                    
                    console.log(`✅ Expired rules retired automatically at version ${state.current_version}.`);
                }

                // ==========================================
                // ⚡ 2. Rebuild KV Cache
                // ==========================================
                // We do this after the Reaper so extensions immediately get the removals
                await rebuildMasterRulesCache(env, ctx);

                // ==========================================
                // 🧹 3. Routine Cleanup & Compliance (Delete Old Data & Kill Idle Sessions)
                // ==========================================
                const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
                const cutoffVersion = Math.max(1, state.current_version - 50);

                await env.DB.batch([
                    env.DB.prepare(`DELETE FROM rules WHERE is_active = 0 AND version_removed < ?`).bind(cutoffVersion),
                    env.DB.prepare(`DELETE FROM unblock_requests WHERE status != 'pending' AND created_at < date('now', '-30 days')`),
                    // 🎯 NEW: Purge 30-day old audit logs
                    env.DB.prepare(`DELETE FROM audit_logs WHERE created_at < date('now', '-30 days')`),
                    // 🎯 NEW: Invalidate session tokens for users inactive for over 1 hour
                    env.DB.prepare(`UPDATE delegated_users SET token = NULL WHERE last_active_at < datetime('now', '-1 hour')`)
                ]);
                
                console.log("✅ Cleanup complete.");
            } catch (err) {
                console.error("❌ Cleanup failed:", err);
            }
        }
        else if (event.cron === "0 * * * *") {
            const timezone = env.SCHOOL_TIMEZONE || "UTC";
            
            const localHourStr = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                hour: "numeric",
                hourCycle: "h23"
            }).format(new Date());
            
            const localHour = parseInt(localHourStr, 10);
            
            if (localHour === 0) {
                console.log(`Midnight struck in ${timezone}! Running daily data rollup...`);
                await runMidnightRollup(env);
            } else {
                console.log(`It's ${localHour}:00 in ${timezone}. Skipping rollup.`);
            }
        }
    }
};

async function runMidnightRollup(env) {
    try {
        if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
            console.error("❌ Missing Cloudflare API credentials. Cannot run rollup.");
            return;
        }

        const timezone = env.SCHOOL_TIMEZONE || "UTC";

        // ==========================================
        // 🎯 EXACT UTC BOUNDARY CALCULATION
        // ==========================================
        const now = new Date();
        // 1. End of Period: Truncate current time to the exact hour (e.g., 04:00:15 -> 04:00:00 UTC)
        const endTimestampUTC = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
        
        // 2. Start of Period: Jump back exactly 24 hours
        let startTimestampUTC = new Date(endTimestampUTC.getTime() - 86400000);
        
        // 3. DST Auto-Corrector: If 24 hours ago wasn't exactly midnight (due to Spring Forward / Fall Back), adjust it.
        const getLocalHour = (date) => parseInt(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(date), 10);
        
        let attempts = 0;
        while (getLocalHour(startTimestampUTC) !== 0 && attempts < 4) {
            const h = getLocalHour(startTimestampUTC);
            if (h > 12) {
                startTimestampUTC = new Date(startTimestampUTC.getTime() + 3600000); // Shift forward if stuck in 23:00
            } else {
                startTimestampUTC = new Date(startTimestampUTC.getTime() - 3600000); // Shift backward if stuck in 01:00
            }
            attempts++;
        }

        // Format for standard SQL (YYYY-MM-DD HH:MM:SS)
        const formatSqlTimestamp = (date) => date.toISOString().replace('T', ' ').substring(0, 19);
        const startSql = formatSqlTimestamp(startTimestampUTC);
        const endSql = formatSqlTimestamp(endTimestampUTC);

        console.log(`Querying Analytics Engine from ${startSql} to ${endSql} (UTC)`);

        // ==========================================
        // 🗄️ QUERY CLOUDFLARE ANALYTICS
        // ==========================================
        // 🎯 FIX: Extract blob5 AS school_id and add it to the GROUP BY clause
        const query = `
            SELECT 
                blob5 AS school_id,
                blob3 AS target, 
                blob4 AS status, 
                SUM(if(blob1 = 'time_log', double1, 0.0)) AS total_minutes, 
                SUM(if(blob1 = 'hit_log', double1, 0.0)) AS total_hits,
                COUNT(DISTINCT blob2) AS unique_students
            FROM glassbox_logs 
            WHERE timestamp >= toDateTime('${startSql}') 
              AND timestamp < toDateTime('${endSql}') 
            GROUP BY school_id, target, status
        `;

        const cfApiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID.trim()}/analytics_engine/sql`;
        const cfResponse = await fetch(cfApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.CF_API_TOKEN.trim()}`,
                'Content-Type': 'application/x-sql'
            },
            body: query
        });

        if (!cfResponse.ok) {
            throw new Error(`Analytics API error: ${await cfResponse.text()}`);
        }

        const responseData = await cfResponse.json();
        const rows = responseData.data || [];

        if (rows.length === 0) {
            console.log("No telemetry data found for yesterday. Sleeping...");
            return;
        }

        // The exact date label for D1, safely shifted back 2 hours to avoid DST date-jumping
        const yesterdayStr = new Intl.DateTimeFormat("en-CA", { 
            timeZone: timezone, 
            year: "numeric", month: "2-digit", day: "2-digit" 
        }).format(new Date(endTimestampUTC.getTime() - 7200000));

        const insertStmts = rows.map(row => {
            // 🎯 FIX: Dynamically read the school_id from the Analytics Engine row (fallback to 1)
            const schoolId = parseInt(row.school_id) || 1;

            return env.TELEMETRY_DB.prepare(`
                INSERT INTO daily_rollups (school_id, log_date, target, status, total_minutes, total_hits, unique_students)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(school_id, log_date, target, status) 
                DO UPDATE SET 
                    total_minutes = excluded.total_minutes,
                    total_hits = excluded.total_hits,
                    unique_students = excluded.unique_students
            `).bind(
                schoolId,
                yesterdayStr,
                row.target,
                row.status,
                row.total_minutes || 0,
                row.total_hits || 0,
                row.unique_students || 0
            );
        });

        const CHUNK_SIZE = 100;
        for (let i = 0; i < insertStmts.length; i += CHUNK_SIZE) {
            const chunk = insertStmts.slice(i, i + CHUNK_SIZE);
            await env.TELEMETRY_DB.batch(chunk);
        }
        
        console.log(`✅ Rollup complete: Saved ${rows.length} aggregated rows for ${yesterdayStr}.`);

        await env.TELEMETRY_DB.prepare(`DELETE FROM daily_rollups WHERE log_date < date('now', '-1 year')`).run();
        console.log("✅ Auto-pruned stale telemetry older than 1 year.");

    } catch (err) {
        console.error("❌ Midnight rollup failed:", err);
    }
}