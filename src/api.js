import { handleFilterRequest } from './api/filter.js';
import { handleAdminRequest } from './api/admin.js';
import { handleInsightRequest } from './api/insight.js';
import { handleAuthRequest } from './api/auth.js';
import { handleStudentRequest } from './api/student.js';

export async function handleApiRequest(request, env, ctx, url) {
    // ---------------------------------------------------------
    // 🔑 ROUTE: Authentication (Login / Logout)
    // ---------------------------------------------------------
    if (url.pathname.startsWith("/api/auth/")) {
        return await handleAuthRequest(request, env, ctx, url);
    }

    // ---------------------------------------------------------
    // 🎓 ROUTE: Student Onboarding & Schools
    // ---------------------------------------------------------
    if (url.pathname.startsWith("/api/student/") || url.pathname.startsWith("/api/schools/")) {
        return await handleStudentRequest(request, env, url);
    }

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