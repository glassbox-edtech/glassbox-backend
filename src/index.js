import { corsHeaders } from './utils/helpers.js';
import { rebuildMasterRulesCache } from './utils/cache.js';
import { handleApiRequest } from './api.js';

export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight requests globally
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);

        try {
            // ---------------------------------------------------------
            // 🌐 MASTER API ROUTER
            // ---------------------------------------------------------
            if (url.pathname.startsWith("/api/")) {
                const response = await handleApiRequest(request, env, ctx, url);
                if (response) return response;
            }

            // 404 Fallback for anything that didn't match the API routes
            return new Response("Not Found", { status: 404, headers: corsHeaders });

        } catch (err) {
            console.error("Global Request Error:", err);
            return Response.json(
                { error: "Server Error", details: err.message }, 
                { status: 500, headers: corsHeaders }
            );
        }
    },

    // ------------------------------------------------------------------
    // ⏱️ CRON JOB: The "Traffic Cop" Event Router
    // ------------------------------------------------------------------
    async scheduled(event, env, ctx) {
        console.log(`Cron triggered for interval: ${event.cron}`);

        // 🧹 1. THE 15-MINUTE JOB: Routine Cache & Rule Cleanup
        if (event.cron === "*/15 * * * *") {
            // Delegates the work to our centralized Cache Manager
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
        
        // 📊 2. THE HOURLY JOB: The Intelligent "Tick-Tock" Rollup
        else if (event.cron === "0 * * * *") {
            // Pull the school's timezone from vars, default to UTC if missing
            const timezone = env.SCHOOL_TIMEZONE || "UTC";
            
            // Extract the current hour (0-23) in that specific timezone
            const localHourStr = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                hour: "numeric",
                hour12: false
            }).format(new Date());
            
            const localHour = parseInt(localHourStr, 10);
            
            // Only execute the massive rollup if it's midnight locally
            if (localHour === 0) {
                console.log(`Midnight struck in ${timezone}! Running daily data rollup...`);
                await runMidnightRollup(env);
            } else {
                console.log(`It's ${localHour}:00 in ${timezone}. Skipping rollup.`);
            }
        }
    }
};

// ==============================================================================
// 📈 THE ROLLUP PIPELINE (Analytics Engine -> D1)
// ==============================================================================
async function runMidnightRollup(env) {
    try {
        if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
            console.error("❌ Missing Cloudflare API credentials. Cannot run rollup.");
            return;
        }

        // 1. Query the Analytics Engine for exactly yesterday's data
        // We use ClickHouse conditional logic (if) to sum hits and minutes properly in a single sweep
        const query = `
            SELECT 
                blob2 AS hash, 
                blob3 AS target, 
                blob4 AS status, 
                SUM(if(blob1 = 'time_log', double1, 0)) AS total_minutes, 
                SUM(if(blob1 = 'hit_log', double1, 0)) AS total_hits 
            FROM glassbox_logs 
            WHERE timestamp >= toStartOfDay(NOW() - INTERVAL '1' DAY) 
              AND timestamp < toStartOfDay(NOW()) 
            GROUP BY hash, target, status
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

        // 2. Determine yesterday's date string (YYYY-MM-DD) based on the school's timezone
        const yesterdayStr = new Intl.DateTimeFormat("en-CA", { 
            timeZone: env.SCHOOL_TIMEZONE || "UTC", 
            year: "numeric", month: "2-digit", day: "2-digit" 
        }).format(new Date(Date.now() - 86400000));

        // 3. Map the results to D1 Insert Statements
        const insertStmts = rows.map(row => {
            return env.TELEMETRY_DB.prepare(`
                INSERT INTO daily_rollups (log_date, student_hash, target, status, total_minutes, total_hits)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(log_date, student_hash, target) 
                DO UPDATE SET 
                    total_minutes = excluded.total_minutes,
                    total_hits = excluded.total_hits
            `).bind(
                yesterdayStr,
                row.hash,
                row.target,
                row.status,
                row.total_minutes,
                row.total_hits
            );
        });

        // 4. Batch insert the data safely in chunks of 100 to respect D1 transaction limits
        const CHUNK_SIZE = 100;
        for (let i = 0; i < insertStmts.length; i += CHUNK_SIZE) {
            const chunk = insertStmts.slice(i, i + CHUNK_SIZE);
            await env.TELEMETRY_DB.batch(chunk);
        }
        
        console.log(`✅ Rollup complete: Saved ${rows.length} aggregated rows for ${yesterdayStr}.`);

        // 5. Auto-Prune (Cold Data Deletion)
        // Keep the database hyper-fast by permanently deleting data over 1 year old
        await env.TELEMETRY_DB.prepare(`DELETE FROM daily_rollups WHERE log_date < date('now', '-1 year')`).run();
        console.log("✅ Auto-pruned stale telemetry older than 1 year.");

    } catch (err) {
        console.error("❌ Midnight rollup failed:", err);
    }
}