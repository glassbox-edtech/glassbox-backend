import { corsHeaders, jsonError } from '../utils/helpers.js';
import { rebuildMasterRulesCache } from '../utils/cache.js';

export async function handleTeacherRequest(request, env, ctx, url) {
    const user = request.user;

    // Must be at least a teacher to hit these routes
    if (!user || !user.id) return jsonError("Forbidden", 403);

    // ---------------------------------------------------------
    // 🎒 ROUTE: GET /api/admin/teacher/classrooms
    // Get assigned classrooms + student count
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/teacher/classrooms") {
        try {
            const { results } = await env.DB.prepare(`
                SELECT c.id, c.name, COUNT(cs.student_hash) as student_count
                FROM classrooms c
                LEFT JOIN classroom_students cs ON c.id = cs.classroom_id
                WHERE c.teacher_id = ? AND c.school_id = ?
                GROUP BY c.id
            `).bind(user.id, user.school_id).all();
            
            return Response.json({ classrooms: results }, { headers: corsHeaders });
        } catch (err) {
            console.error("List Teacher Classrooms Error:", err);
            return jsonError("Failed to fetch classrooms", 500);
        }
    }

    // ---------------------------------------------------------
    // 🛡️ ROUTE: GET /api/admin/teacher/rules
    // Get active rules scoped to this teacher's classrooms
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/admin/teacher/rules") {
        try {
            const { results } = await env.DB.prepare(`
                SELECT r.id, r.target, r.action, r.expires_at, c.name as classroom_name
                FROM rules r
                JOIN classrooms c ON r.classroom_id = c.id
                WHERE r.is_active = 1 AND c.teacher_id = ? AND r.school_id = ?
                ORDER BY r.expires_at ASC
            `).bind(user.id, user.school_id).all();
            
            return Response.json({ rules: results }, { headers: corsHeaders });
        } catch (err) {
            console.error("List Teacher Rules Error:", err);
            return jsonError("Failed to fetch rules", 500);
        }
    }

    // ---------------------------------------------------------
    // 🛡️ ROUTE: POST /api/admin/teacher/rules
    // Create a temporary rule for a specific classroom
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/teacher/rules") {
        try {
            const { classroomId, target, matchType, action, expiresInHours } = await request.json();

            if (!classroomId || !target || !action) return jsonError("Missing required fields", 400);

            // Security Check: Does this teacher own this classroom?
            const classCheck = await env.DB.prepare(`SELECT id FROM classrooms WHERE id = ? AND teacher_id = ? AND school_id = ?`).bind(classroomId, user.id, user.school_id).first();
            if (!classCheck) return jsonError("Forbidden. You do not own this classroom.", 403);

            // Calculate expiration
            let expiresAt = null;
            if (expiresInHours && expiresInHours > 0) {
                expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString().replace('T', ' ').substring(0, 19);
            }

            await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
            const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();

            // Insert Rule scoped to both School and Classroom
            await env.DB.prepare(`
                INSERT INTO rules (school_id, classroom_id, target, match_type, action, version_added, expires_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(user.school_id, classroomId, target, matchType, action, state.current_version, expiresAt).run();

            // Rebuild cache for this school so students get it on next sync
            await rebuildMasterRulesCache(env, ctx, user.school_id);

            return Response.json({ success: true }, { headers: corsHeaders });
        } catch (err) {
            console.error("Create Teacher Rule Error:", err);
            return jsonError("Failed to create rule", 500);
        }
    }

    // ---------------------------------------------------------
    // 🗑️ ROUTE: POST /api/admin/teacher/rules/remove
    // Remove a classroom rule early
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/admin/teacher/rules/remove") {
        try {
            const { ruleId } = await request.json();

            // Security Check: Rule must belong to a classroom owned by this teacher
            const ruleCheck = await env.DB.prepare(`
                SELECT r.id 
                FROM rules r JOIN classrooms c ON r.classroom_id = c.id 
                WHERE r.id = ? AND c.teacher_id = ?
            `).bind(ruleId, user.id).first();
            
            if (!ruleCheck) return jsonError("Forbidden or rule not found.", 403);

            await env.DB.prepare(`UPDATE system_state SET current_version = current_version + 1 WHERE id = 1`).run();
            const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();

            await env.DB.prepare(`UPDATE rules SET is_active = 0, version_removed = ? WHERE id = ?`).bind(state.current_version, ruleId).run();
            await rebuildMasterRulesCache(env, ctx, user.school_id);

            return Response.json({ success: true }, { headers: corsHeaders });
        } catch (err) {
            console.error("Remove Teacher Rule Error:", err);
            return jsonError("Failed to remove rule", 500);
        }
    }

    return null;
}