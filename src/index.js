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
    // CRON JOB: Automatically rebuilds KV cache in the background
    // ------------------------------------------------------------------
    async scheduled(event, env, ctx) {
        console.log("Cron triggered...");
        // Delegates the work to our centralized Cache Manager
        await rebuildMasterRulesCache(env, ctx);
    }
};