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
            await rebuildMasterRulesCache(env, ctx);

            try {
                console.log("Running routine database cleanup...");
                
                const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
                const cutoffVersion = Math.max(1, state.current_version - 50);

                await env.DB.batch([
                    env.DB.prepare(`DELETE FROM rules WHERE is_active = 0 AND version_removed < ?`).bind(cutoffVersion),
                    env.DB.prepare(`DELETE FROM unblock_requests WHERE status != 'pending' AND created_at < date('now', '-30 days')`)
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
        // 🎯 FIX: Changed 0 to 0.0 so both IF arguments are identical 'Double' types!
        const query = `
            SELECT 
                blob3 AS target, 
                blob4 AS status, 
                SUM(if(blob1 = 'time_log', double1, 0.0)) AS total_minutes, 
                SUM(if(blob1 = 'hit_log', double1, 0.0)) AS total_hits,
                COUNT(DISTINCT blob2) AS unique_students
            FROM glassbox_logs 
            WHERE timestamp >= '${startSql}' 
              AND timestamp < '${endSql}' 
            GROUP BY target, status
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
            return env.TELEMETRY_DB.prepare(`
                INSERT INTO daily_rollups (log_date, target, status, total_minutes, total_hits, unique_students)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(log_date, target, status) 
                DO UPDATE SET 
                    total_minutes = excluded.total_minutes,
                    total_hits = excluded.total_hits,
                    unique_students = excluded.unique_students
            `).bind(
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