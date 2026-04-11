import { corsHeaders, jsonError } from '../utils/helpers.js';

// ---------------------------------------------------------
// 🔐 CRYPTO HELPERS (SERVER-SIDE)
// ---------------------------------------------------------
function hexToBuffer(hex) {
    const view = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        view[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return view.buffer;
}

function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compute HMAC-SHA256 Proof Verification
async function computeHMAC(keyHex, messageStr) {
    const keyBuffer = hexToBuffer(keyHex);
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(messageStr));
    return bufferToHex(signature);
}

// Basic SHA-256
async function sha256(message) {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(message));
    return bufferToHex(hash);
}

// PBKDF2 Key Derivation (Used dynamically for the Master Admin backdoor)
async function computePBKDF2(passwordHex, saltStr) {
    const baseKey = await crypto.subtle.importKey(
        'raw', hexToBuffer(passwordHex), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const encoder = new TextEncoder();
    const derivedBits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: encoder.encode(saltStr), iterations: 100000, hash: 'SHA-256' },
        baseKey, 256
    );
    return bufferToHex(derivedBits);
}

export async function handleAuthRequest(request, env, ctx, url) {
    
    // ---------------------------------------------------------
    // 🛡️ STEP 1: POST /api/auth/challenge (The Handshake)
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/auth/challenge") {
        try {
            const { username } = await request.json();
            if (!username) return jsonError("Username is required.", 400);

            let salt;
            
            // 1. Master Backdoor Failsafe
            if (username === 'admin') {
                salt = "master_glassbox_salt";
            } else {
                // 2. Database Lookup
                const user = await env.DB.prepare(`SELECT salt FROM delegated_users WHERE username = ?`).bind(username).first();
                
                // Security: If user doesn't exist, return a fake salt so attackers can't "enumerate" valid usernames
                salt = user && user.salt ? user.salt : await sha256(username + "fake_salt_secret").then(h => h.substring(0, 16));
            }

            // Generate a cryptographically secure random nonce
            const nonceBytes = new Uint8Array(16);
            crypto.getRandomValues(nonceBytes);
            const nonce = bufferToHex(nonceBytes);

            // Store nonce in KV valid for exactly 60 seconds
            await env.GLASSBOX_KV.put(`auth_nonce_${username}`, nonce, { expirationTtl: 60 });

            return Response.json({ success: true, salt, nonce }, { headers: corsHeaders });
        } catch (err) {
            console.error("Challenge API Error:", err);
            return jsonError("Failed to initiate challenge.", 500);
        }
    }

    // ---------------------------------------------------------
    // 🔐 STEP 2: POST /api/auth/login (Zero-Knowledge Verification)
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
        try {
            const { username, clientHmac } = await request.json();

            if (!username || !clientHmac) return jsonError("Username and HMAC proof are required.", 400);

            // 1. Retrieve the challenge nonce
            const nonce = await env.GLASSBOX_KV.get(`auth_nonce_${username}`);
            if (!nonce) return jsonError("Challenge expired or invalid. Please try logging in again.", 401);

            // Immediately delete the nonce to prevent Replay Attacks!
            ctx.waitUntil(env.GLASSBOX_KV.delete(`auth_nonce_${username}`));

            let userRecord;
            let storedKeyHex;

            // 2. Fetch the Master Key
            if (username === 'admin') {
                // Generate the PBKDF2 Master Key dynamically from the Cloudflare environment variable
                const adminBaseHash = await sha256(env.ADMIN_SECRET);
                storedKeyHex = await computePBKDF2(adminBaseHash, "master_glassbox_salt");
                userRecord = { id: 0, role: 'master_admin', school_id: 1 };
            } else {
                const user = await env.DB.prepare(`SELECT id, school_id, role, password_hash FROM delegated_users WHERE username = ?`).bind(username).first();
                if (!user) return jsonError("Invalid credentials.", 401);
                
                storedKeyHex = user.password_hash; // In V2, password_hash column now stores the PBKDF2 key
                userRecord = user;
            }

            // 3. Compute the Expected Proof
            const expectedHmac = await computeHMAC(storedKeyHex, nonce);

            // 4. Verify Proof
            if (clientHmac !== expectedHmac) {
                return jsonError("Invalid credentials.", 401);
            }

            // 5. Authentication Successful! Generate Session
            const token = crypto.randomUUID();
            
            if (username !== 'admin') {
                await env.DB.prepare(`UPDATE delegated_users SET token = ? WHERE id = ?`).bind(token, userRecord.id).run();
            }

            // Background Audit Logging (Fire and Forget)
            ctx.waitUntil((async () => {
                try {
                    const settingsResult = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'enable_audit_logging'`).first();
                    if (settingsResult && settingsResult.setting_value === '1') {
                        await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, target) VALUES (?, 'login', 'system')`).bind(userRecord.id).run();
                    }
                } catch (e) { console.error("Failed to log audit event:", e); }
            })());

            return Response.json({
                success: true,
                token: username === 'admin' ? env.ADMIN_SECRET : token,
                role: userRecord.role,
                school_id: userRecord.school_id
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
            if (token !== env.ADMIN_SECRET) {
                await env.DB.prepare(`UPDATE delegated_users SET token = NULL WHERE token = ?`).bind(token).run();
            }
        }
        return Response.json({ success: true, message: "Logged out successfully." }, { headers: corsHeaders });
    }

    return null;
}