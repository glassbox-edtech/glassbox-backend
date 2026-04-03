import { handleFilterRequest } from './api/filter.js';
import { handleAdminRequest } from './api/admin.js';
import { handleInsightRequest } from './api/insight.js';

export async function handleApiRequest(request, env, ctx, url) {
    // ---------------------------------------------------------
    // 🏛️ ROUTE: IT Admin Dashboard
    // ---------------------------------------------------------
    // Admin routes must be checked first to ensure auth middleware runs
    if (url.pathname.startsWith("/api/admin/")) {
        return await handleAdminRequest(request, env, ctx, url);
    }

    // ---------------------------------------------------------
    // 🛡️ ROUTE: Student Filter Extension
    // ---------------------------------------------------------
    if (url.pathname.startsWith("/api/filter/")) {
        return await handleFilterRequest(request, env, url);
    }

    // ---------------------------------------------------------
    // 📊 ROUTE: Insight Extension
    // ---------------------------------------------------------
    if (url.pathname.startsWith("/api/insight/")) {
        return await handleInsightRequest(request, env, url);
    }

    return null; // Return null if no route matched so index.js can 404
}