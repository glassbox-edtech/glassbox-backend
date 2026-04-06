import { corsHeaders, jsonError } from '../utils/helpers.js';

export async function handleAdminSettingsRequest(request, env, ctx, url) {
    if (url.pathname === "/api/admin/settings") {
        if (request.method === "GET") {
            try {
                const { results } = await env.DB.prepare(`SELECT setting_key, setting_value, description FROM system_settings`).all();
                return Response.json({ settings: results }, { headers: corsHeaders });
            } catch (err) {
                return jsonError("Failed to fetch settings", 500);
            }
        }
        
        if (request.method === "POST") {
            try {
                const body = await request.json();
                
                // Expecting payload: { settings: [{ key: "...", value: "..." }] }
                if (!body.settings || !Array.isArray(body.settings)) {
                    return jsonError("Invalid settings payload", 400);
                }

                const updateStmts = body.settings.map(s => 
                    env.DB.prepare(
                        `UPDATE system_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?`
                    ).bind(String(s.value), String(s.key))
                );

                if (updateStmts.length > 0) {
                    await env.DB.batch(updateStmts);
                }

                return Response.json({ success: true, message: "Settings saved successfully." }, { headers: corsHeaders });
            } catch (err) {
                console.error("Settings Save Error:", err);
                return jsonError("Failed to save settings", 500);
            }
        }
    }

    return null;
}