import { jsonError } from '../utils/helpers.js';
import { handleAdminFilterRequest } from './filter.js';
import { handleAdminInsightRequest } from './insight.js';
import { handleAdminSettingsRequest } from './settings.js';

export async function handleAdminRequest(request, env, ctx, url) {
    // 🔒 GLOBAL AUTH MIDDLEWARE
    // Every request hitting this file MUST have a valid Bearer token.
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
        return jsonError("Unauthorized", 401);
    }

    // ---------------------------------------------------------
    // 🚦 ROUTING: Hand off to the specific domain modules
    // ---------------------------------------------------------

    // Hand off Filter-related admin requests
    if (url.pathname.startsWith("/api/admin/filter/")) {
        return await handleAdminFilterRequest(request, env, ctx, url);
    }

    // Hand off Insight-related admin requests
    if (url.pathname.startsWith("/api/admin/insight/")) {
        return await handleAdminInsightRequest(request, env, ctx, url);
    }

    // ---------------------------------------------------------
    // ⚙️ ROUTE: Global System Settings
    // ---------------------------------------------------------
    if (url.pathname.startsWith("/api/admin/settings")) {
        return await handleAdminSettingsRequest(request, env, ctx, url);
    }

    return null; // Hand back to main router if no route matched
}