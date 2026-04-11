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

async function sha256(message) {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(message));
    return bufferToHex(hash);
}

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

export async function handleAdminUsersRequest(request, env, ctx, url) {
    const user = request.user;

    // Teachers cannot manage other staff
    if (user.role === 'teacher') {
        return jsonError("Forbidden. IT Admin access required.", 403);
    }

    // ---------------------------------------------------------
    // 👤 ROUTE: GET /api/admin/users
    // List staff accounts
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/users") {
        try {
            let query = `
                SELECT u.id, u.school_id, u.role, u.username, u.created_at, u.last_active_at, s.name as school_name 
                FROM delegated_users u
                JOIN schools s ON u.school_id = s.id
            `;
            let params = [];

            // Scope it: Master admins see all, School admins only see their own staff
            if (user.role !== 'master_admin') {
                query += ` WHERE u.school_id = ?`;
                params.push(user.school_id);
            }

            query += ` ORDER BY u.created_at DESC`;
            const { results } = await env.DB.prepare(query).bind(...params).all();
            
            return Response.json({ users: results }, { headers: corsHeaders });
        } catch (err) {
            console.error("List Users Error:", err);
            return jsonError("Failed to fetch users.", 500);
        }
    }

    // ---------------------------------------------------------
    // 👤 ROUTE: POST /api/admin/users
    // Create, Delete, or Reset Password
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/users") {
        try {
            const body = await request.json();
            const { action, id, username, password, role, schoolId } = body;

            if (action === "create") {
                if (!username || !password || !role) return jsonError("Username, password, and role are required.", 400);

                // Enforce scoping and permissions
                let targetSchoolId = schoolId || user.school_id;
                
                if (user.role !== 'master_admin') {
                    targetSchoolId = user.school_id; // Lock to their own school
                    if (role === 'master_admin') return jsonError("Only Master Admins can create other Master Admins.", 403);
                }

                // 🎯 NEW: Generate unique salt and derive PBKDF2 key
                const saltBytes = new Uint8Array(16);
                crypto.getRandomValues(saltBytes);
                const saltStr = bufferToHex(saltBytes);

                const baseHash = await sha256(password);
                const derivedKey = await computePBKDF2(baseHash, saltStr);

                try {
                    await env.DB.prepare(
                        `INSERT INTO delegated_users (school_id, role, username, password_hash, salt) VALUES (?, ?, ?, ?, ?)`
                    ).bind(targetSchoolId, role, username, derivedKey, saltStr).run();
                    
                    return Response.json({ success: true, message: `User '${username}' created.` }, { headers: corsHeaders });
                } catch (dbErr) {
                    if (dbErr.message && dbErr.message.includes('UNIQUE constraint failed')) {
                        return jsonError("That username is already taken.", 409);
                    }
                    throw dbErr;
                }
            } 
            else if (action === "delete") {
                if (!id) return jsonError("User ID required.", 400);

                // Prevent a school admin from deleting a master admin or someone outside their school
                if (user.role !== 'master_admin') {
                    const targetUser = await env.DB.prepare(`SELECT school_id, role FROM delegated_users WHERE id = ?`).bind(id).first();
                    if (!targetUser || targetUser.school_id !== user.school_id || targetUser.role === 'master_admin') {
                        return jsonError("Forbidden. You do not have permission to delete this user.", 403);
                    }
                }

                await env.DB.prepare(`DELETE FROM delegated_users WHERE id = ?`).bind(id).run();
                return Response.json({ success: true, message: "User deleted successfully." }, { headers: corsHeaders });
            }
            else if (action === "reset_password") {
                if (!id || !password) return jsonError("User ID and new password are required.", 400);

                if (user.role !== 'master_admin') {
                    const targetUser = await env.DB.prepare(`SELECT school_id, role FROM delegated_users WHERE id = ?`).bind(id).first();
                    if (!targetUser || targetUser.school_id !== user.school_id || targetUser.role === 'master_admin') {
                        return jsonError("Forbidden. You do not have permission to reset this user's password.", 403);
                    }
                }

                // 🎯 NEW: Generate new salt and derive new PBKDF2 key on password reset
                const saltBytes = new Uint8Array(16);
                crypto.getRandomValues(saltBytes);
                const saltStr = bufferToHex(saltBytes);

                const baseHash = await sha256(password);
                const derivedKey = await computePBKDF2(baseHash, saltStr);
                
                // Update the password, salt AND force a logout by destroying the session token
                await env.DB.prepare(`UPDATE delegated_users SET password_hash = ?, salt = ?, token = NULL WHERE id = ?`).bind(derivedKey, saltStr, id).run();
                return Response.json({ success: true, message: "Password updated and active sessions terminated." }, { headers: corsHeaders });
            }

            return jsonError("Invalid action type.", 400);
        } catch (err) {
            console.error("Modify Users Error:", err);
            return jsonError("Failed to process user action.", 500);
        }
    }

    return null;
}