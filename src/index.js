import { corsHeaders } from './utils/helpers.js';
import { rebuildMasterRulesCache } from './utils/cache.js';
import { handleFilterRequest } from './api/filter.js';
import { handleAdminRequest } from './api/admin.js';

export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight requests globally
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);

        try {
            // ---------------------------------------------------------
            // 🛡️ SUB-ROUTER: Student Filter Extension
            // ---------------------------------------------------------
            if (url.pathname.startsWith("/api/filter/")) {
                const response = await handleFilterRequest(request, env, url);
                if (response) return response;
            }

            // ---------------------------------------------------------
            // 🏛️ SUB-ROUTER: IT Admin Dashboard
            // ---------------------------------------------------------
            if (url.pathname.startsWith("/api/admin/")) {
                const response = await handleAdminRequest(request, env, ctx, url);
                if (response) return response;
            }
            
            // ---------------------------------------------------------
            // 📊 SUB-ROUTER: Insight Extension (Future Placeholder)
            // ---------------------------------------------------------
            if (url.pathname.startsWith("/api/insight/")) {
                // Future code will go here!
            }

            // 404 Fallback
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
    // CRON JOB: Automatically rebuilds KV cache in the background
    // ------------------------------------------------------------------
    async scheduled(event, env, ctx) {
        console.log("Cron triggered...");
        // ⚡ Delegates the work to our new centralized Cache Manager
        await rebuildMasterRulesCache(env, ctx);
    }
};