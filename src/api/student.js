import { corsHeaders, cacheHeaders, jsonError } from '../utils/helpers.js';

export async function handleStudentRequest(request, env, url) {

    // ---------------------------------------------------------
    // 🏫 ROUTE: GET /api/schools/public
    // Returns a lightweight, public list of schools for the setup dropdown
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/schools/public") {
        try {
            const { results } = await env.DB.prepare(
                `SELECT id, name FROM schools ORDER BY name ASC`
            ).all();

            return Response.json({ schools: results }, { headers: cacheHeaders });
        } catch (err) {
            console.error("Public Schools Fetch Error:", err);
            return jsonError("Failed to fetch school list.", 500);
        }
    }

    // ---------------------------------------------------------
    // 🤝 ROUTE: GET /api/student/me
    // The Silent Startup Handshake. Checks if a hash is already registered.
    // ---------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/student/me") {
        try {
            const studentHash = url.searchParams.get("hash");
            if (!studentHash) return jsonError("Hash is required.", 400);

            const student = await env.DB.prepare(
                `SELECT school_id FROM students WHERE student_hash = ?`
            ).bind(studentHash).first();

            if (student) {
                return Response.json({ registered: true, schoolId: student.school_id }, { headers: corsHeaders });
            } else {
                return jsonError("Student not registered.", 404);
            }
        } catch (err) {
            console.error("Student Check Error:", err);
            return jsonError("Failed to check registration status.", 500);
        }
    }

    // ---------------------------------------------------------
    // 🔐 ROUTE: POST /api/student/register
    // The Enrollment Endpoint with a strict Server-Side Lock
    // ---------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/student/register") {
        try {
            const body = await request.json();
            const { studentHash, schoolId } = body;

            if (!studentHash || !schoolId) {
                return jsonError("Student Hash and School ID are required.", 400);
            }

            // 1. Check the Server-Side Lock
            const existingStudent = await env.DB.prepare(
                `SELECT school_id FROM students WHERE student_hash = ?`
            ).bind(studentHash).first();

            if (existingStudent) {
                if (existingStudent.school_id !== schoolId) {
                    return jsonError("Security Alert: Your device is permanently locked to a different school. Please contact IT if you have transferred.", 403);
                }
                // They are trying to register for the school they are already locked to. That's fine!
                return Response.json({ success: true, message: "Device is already securely registered to this school." }, { headers: corsHeaders });
            }

            // 2. Validate the School ID exists
            const schoolCheck = await env.DB.prepare(`SELECT id FROM schools WHERE id = ?`).bind(schoolId).first();
            if (!schoolCheck) {
                return jsonError("Invalid School ID.", 400);
            }

            // 3. Register the Student
            await env.DB.prepare(
                `INSERT INTO students (student_hash, school_id) VALUES (?, ?)`
            ).bind(studentHash, schoolId).run();

            return Response.json({ success: true, message: "Device securely registered." }, { headers: corsHeaders });

        } catch (err) {
            console.error("Student Registration Error:", err);
            return jsonError("Failed to register student.", 500);
        }
    }

    return null;
}