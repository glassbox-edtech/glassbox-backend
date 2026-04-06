import { jsonError, corsHeaders } from '../utils/helpers.js';
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

    // ---------------------------------------------------------
    // 🔔 ROUTE: VAPID Public Key for Web Push
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/vapid-public") {
        try {
            if (!env.VAPID_KEYS) {
                return jsonError("VAPID keys are not configured on the server.", 500);
            }
            
            // Parse the stored JSON secret
            const keys = JSON.parse(env.VAPID_KEYS);
            
            // Return ONLY the public key
            return Response.json({ publicKey: keys.publicKey }, { headers: corsHeaders });
        } catch (err) {
            console.error("VAPID Parse Error:", err);
            return jsonError("Failed to process VAPID keys.", 500);
        }
    }

    // ---------------------------------------------------------
    // 💾 ROUTE: Save Web Push Subscription
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/push/subscribe") {
        try {
            const sub = await request.json();
            
            // Validate that we received a properly formatted Web Push subscription object
            if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
                return jsonError("Invalid subscription payload.", 400);
            }

            // Insert or update the subscription based on the unique endpoint URL
            await env.DB.prepare(
                `INSERT INTO admin_push_subscriptions (endpoint, p256dh, auth) 
                 VALUES (?, ?, ?) 
                 ON CONFLICT(endpoint) DO UPDATE SET 
                    p256dh = excluded.p256dh, 
                    auth = excluded.auth`
            ).bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth).run();

            return Response.json({ success: true, message: "Subscription saved successfully." }, { headers: corsHeaders });
        } catch (err) {
            console.error("Push Subscription Error:", err);
            return jsonError("Failed to save push subscription.", 500);
        }
    }

    return null; // Hand back to main router if no route matched
}