import { jsonError, corsHeaders } from '../utils/helpers.js';
import { handleAdminFilterRequest } from './filter.js';
import { handleAdminInsightRequest } from './insight.js';
import { handleAdminSettingsRequest } from './settings.js';

export async function handleAdminRequest(request, env, ctx, url) {
    // 🔒 GLOBAL AUTH MIDDLEWARE (RBAC)
    // Every request hitting this file MUST have a valid Bearer token.
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return jsonError("Unauthorized", 401);
    }

    const token = authHeader.substring(7);
    let user = null;

    // 1. MASTER BACKDOOR: Check if they are using the environment secret (Fresh installs)
    if (token === env.ADMIN_SECRET) {
        user = { id: 0, school_id: 1, role: 'master_admin', username: 'admin_backdoor' };
    } 
    // 2. STANDARD DB CHECK: Validate token against delegated_users
    else {
        user = await env.DB.prepare(
            `SELECT id, school_id, role, username FROM delegated_users WHERE token = ?`
        ).bind(token).first();

        if (!user) {
            return jsonError("Unauthorized or Session Expired", 401);
        }

        // ⏱️ BUMP IDLE TIMEOUT: Update the last_active_at timestamp so they don't get logged out!
        // We use ctx.waitUntil so the API doesn't slow down waiting for this database write.
        ctx.waitUntil(
            env.DB.prepare(
                `UPDATE delegated_users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?`
            ).bind(user.id).run()
        );
    }

    // Attach the user object to the request so downstream routes can use user.school_id and user.role!
    request.user = user;

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

            // 🎯 NEW: Scoped to the admin's specific school!
            await env.DB.prepare(
                `INSERT INTO admin_push_subscriptions (school_id, endpoint, p256dh, auth) 
                 VALUES (?, ?, ?, ?) 
                 ON CONFLICT(endpoint) DO UPDATE SET 
                    p256dh = excluded.p256dh, 
                    auth = excluded.auth`
            ).bind(user.school_id, sub.endpoint, sub.keys.p256dh, sub.keys.auth).run();

            return Response.json({ success: true, message: "Subscription saved successfully." }, { headers: corsHeaders });
        } catch (err) {
            console.error("Push Subscription Error:", err);
            return jsonError("Failed to save push subscription.", 500);
        }
    }

    return null; // Hand back to main router if no route matched
}