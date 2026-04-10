import { corsHeaders, jsonError } from '../utils/helpers.js';

// Native WebCrypto SHA-256 Hashing for Passwords
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleAuthRequest(request, env, ctx, url) {
    
    // ---------------------------------------------------------
    // 🔐 ROUTE: POST /api/auth/login
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
        try {
            const body = await request.json();
            const { username, password } = body;

            if (!username || !password) {
                return jsonError("Username and password are required.", 400);
            }

            // 1. MASTER BACKDOOR (Failsafe for initial deployment)
            // If the username is 'admin' and they provide the Cloudflare ENV Secret, let them in.
            // This is required so you can log in the very first time to create the initial accounts!
            if (username === 'admin' && password === env.ADMIN_SECRET) {
                return Response.json({
                    success: true,
                    token: env.ADMIN_SECRET, // Use the master secret as the session token
                    role: 'master_admin',
                    school_id: 1 // Defaults to the fallback school
                }, { headers: corsHeaders });
            }

            // 2. STANDARD RBAC LOGIN
            const hashedPassword = await hashPassword(password);
            
            const user = await env.DB.prepare(
                `SELECT id, school_id, role, password_hash FROM delegated_users WHERE username = ?`
            ).bind(username).first();

            if (!user || user.password_hash !== hashedPassword) {
                return jsonError("Invalid username or password.", 401);
            }

            // 3. GENERATE SESSION TOKEN
            const token = crypto.randomUUID();
            
            await env.DB.prepare(
                `UPDATE delegated_users SET token = ? WHERE id = ?`
            ).bind(token, user.id).run();

            // 4. BACKGROUND AUDIT LOGGING (Fire and Forget)
            // We use ctx.waitUntil so the user doesn't have to wait for the logging to finish to log in!
            ctx.waitUntil(
                (async () => {
                    try {
                        const settingsResult = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'enable_audit_logging'`).first();
                        if (settingsResult && settingsResult.setting_value === '1') {
                            await env.DB.prepare(
                                `INSERT INTO audit_logs (user_id, action, target) VALUES (?, 'login', 'system')`
                            ).bind(user.id).run();
                        }
                    } catch (e) {
                        console.error("Failed to log audit event:", e);
                    }
                })()
            );

            return Response.json({
                success: true,
                token: token,
                role: user.role,
                school_id: user.school_id
            }, { headers: corsHeaders });

        } catch (err) {
            console.error("Login API Error:", err);
            return jsonError("Internal Server Error during login.", 500);
        }
    }
    
    // ---------------------------------------------------------
    // 🚪 ROUTE: POST /api/auth/logout
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const authHeader = request.headers.get("Authorization");
        if (authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.substring(7);
            
            // Invalidate the token in the database so it can't be used again
            // (We skip checking if it was the master secret backdoor)
            if (token !== env.ADMIN_SECRET) {
                await env.DB.prepare(`UPDATE delegated_users SET token = NULL WHERE token = ?`).bind(token).run();
            }
        }
        
        return Response.json({ success: true, message: "Logged out successfully." }, { headers: corsHeaders });
    }

    return null;
}