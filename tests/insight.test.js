import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleInsightRequest, handleAdminInsightRequest } from '../src/api/insight.js';

// Mock context
const ctx = {};

// Save the original fetch to restore it later
const originalFetch = globalThis.fetch;

// ==========================================
// 🛠️ DATABASE & ENV SETUP HOOK
// ==========================================
beforeEach(async () => {
    // 1. Wipe and recreate Main DB tables
    await env.DB.batch([
        env.DB.prepare(`DROP TABLE IF EXISTS system_settings`),
        env.DB.prepare(`DROP TABLE IF EXISTS approved_apps`),
        env.DB.prepare(`CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL)`),
        env.DB.prepare(`CREATE TABLE approved_apps (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL UNIQUE, app_name TEXT NOT NULL, category TEXT)`),
        
        // Seed default config and one approved app
        env.DB.prepare(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('insight_unapproved_threshold_minutes', '5')`),
        env.DB.prepare(`INSERT INTO approved_apps (domain, app_name, category) VALUES ('ixl.com', 'IXL Math', 'Education')`)
    ]);

    // 2. Wipe and recreate Telemetry DB table
    await env.TELEMETRY_DB.batch([
        env.TELEMETRY_DB.prepare(`DROP TABLE IF EXISTS daily_rollups`),
        env.TELEMETRY_DB.prepare(`CREATE TABLE daily_rollups (id INTEGER PRIMARY KEY AUTOINCREMENT, log_date TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, total_minutes REAL DEFAULT 0, total_hits INTEGER DEFAULT 0, unique_students INTEGER DEFAULT 0)`)
    ]);

    // 3. Mock global fetch for Analytics Engine REST API calls
    globalThis.fetch = vi.fn();
    
    // 4. Ensure Analytics Engine binding exists and spy on it
    if (!env.GLASSBOX_LOGS) {
        env.GLASSBOX_LOGS = { writeDataPoint: vi.fn() };
    } else {
        vi.spyOn(env.GLASSBOX_LOGS, 'writeDataPoint');
    }

    // 5. Mock Cloudflare API Credentials required by Admin routes
    env.CF_ACCOUNT_ID = "mock_account_id_123";
    env.CF_API_TOKEN = "mock_api_token_abc";
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

// ==========================================
// 🎒 STUDENT-FACING INSIGHT ROUTES
// ==========================================
describe('Insight API - Student Agent Routes', () => {

    it('should successfully sync system config and approved apps list', async () => {
        const req = new Request('https://worker.local/api/insight/sync', { method: 'GET' });
        const response = await handleInsightRequest(req, env, new URL(req.url));
        const data = await response.json();

        expect(response.status).toBe(200);
        
        // Verify Config
        expect(data.config).toBeDefined();
        expect(data.config.insight_unapproved_threshold_minutes).toBe('5');
        
        // Verify Apps
        expect(data.approvedApps).toBeDefined();
        expect(data.approvedApps.length).toBe(1);
        expect(data.approvedApps).toContain('ixl.com');
    });

    it('should ingest telemetry logs directly into Analytics Engine and properly categorize them', async () => {
        const payload = {
            studentHash: 'test-hash-123',
            logs: [
                { type: 'time', target: 'coolmathgames.com', value: 15 },
                { type: 'hit', target: 'ixl.com/math/test', value: 1 }
            ]
        };

        const req = new Request('https://worker.local/api/insight/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const response = await handleInsightRequest(req, env, new URL(req.url));
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);

        // Assert AE writeDataPoint was called twice (once for each log)
        expect(env.GLASSBOX_LOGS.writeDataPoint).toHaveBeenCalledTimes(2);
        
        // Check time log (Ensure it was flagged as 'unapproved' because it's not in the DB)
        expect(env.GLASSBOX_LOGS.writeDataPoint).toHaveBeenCalledWith({
            blobs: ['time_log', 'test-hash-123', 'coolmathgames.com', 'unapproved'],
            doubles: [15]
        });

        // Check hit log (Ensure the base domain was matched and it was flagged as 'approved')
        expect(env.GLASSBOX_LOGS.writeDataPoint).toHaveBeenCalledWith({
            blobs: ['hit_log', 'test-hash-123', 'ixl.com/math/test', 'approved'],
            doubles: [1]
        });
    });

});

// ==========================================
// 🏛️ ADMIN-FACING INSIGHT ROUTES
// ==========================================
describe('Admin Insight API - Approved Apps Management', () => {

    it('should add a new approved app to the database', async () => {
        const req = new Request('https://worker.local/api/admin/insight/apps', {
            method: 'POST',
            body: JSON.stringify({ action: 'add', domain: 'canvas.instructure.com', appName: 'Canvas', category: 'LMS' })
        });

        const response = await handleAdminInsightRequest(req, env, ctx, new URL(req.url));
        const data = await response.json();
        
        expect(response.status).toBe(200);
        expect(data.success).toBe(true);

        const dbCheck = await env.DB.prepare(`SELECT * FROM approved_apps WHERE domain = 'canvas.instructure.com'`).first();
        expect(dbCheck.app_name).toBe('Canvas');
        expect(dbCheck.category).toBe('LMS');
    });

    it('should retrieve the list of approved apps', async () => {
        const req = new Request('https://worker.local/api/admin/insight/apps', { method: 'GET' });
        const response = await handleAdminInsightRequest(req, env, ctx, new URL(req.url));
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.apps.length).toBe(1);
        expect(data.apps[0].domain).toBe('ixl.com');
    });

    it('should remove an approved app from the database', async () => {
        const req = new Request('https://worker.local/api/admin/insight/apps', {
            method: 'POST',
            body: JSON.stringify({ action: 'remove', domain: 'ixl.com' })
        });

        const response = await handleAdminInsightRequest(req, env, ctx, new URL(req.url));
        expect(response.status).toBe(200);

        const dbCheck = await env.DB.prepare(`SELECT * FROM approved_apps WHERE domain = 'ixl.com'`).first();
        expect(dbCheck).toBeNull();
    });

});

describe('Admin Insight API - Telemetry Reporting', () => {

    it('should route macroscopic queries (>7 days) to Warm Storage (D1)', async () => {
        // 1. Seed D1 Telemetry Database with a mock rollup
        await env.TELEMETRY_DB.prepare(`
            INSERT INTO daily_rollups (log_date, target, status, total_minutes, total_hits, unique_students)
            VALUES ('2026-01-01', 'coolmath.com', 'unapproved', 120.5, 50, 10)
        `).run();

        // 2. Request a 30-day timeframe
        const req = new Request('https://worker.local/api/admin/insight/reports?timeframe=30', { method: 'GET' });
        const response = await handleAdminInsightRequest(req, env, ctx, new URL(req.url));
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.reports.length).toBe(1);
        expect(data.reports[0].target).toBe('coolmath.com');
        expect(data.reports[0].total_minutes).toBe(120.5);
        expect(data.reports[0].unique_students).toBe(10);
        
        // 3. CRITICAL ASSERTION: Ensure globalThis.fetch was NOT called.
        // This proves the Worker successfully read from D1 and avoided the Analytics Engine API limit!
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should route live outliers queries to Hot Storage (Analytics Engine via Fetch)', async () => {
        // 1. Mock the Cloudflare Analytics Engine JSON response
        const mockCfResponse = {
            data: [
                { student_hash: 'bad-kid-99', target: 'games.com', total_minutes: 180.2 }
            ]
        };
        
        globalThis.fetch.mockResolvedValue(new Response(JSON.stringify(mockCfResponse), { status: 200 }));

        // 2. Make the Outliers request (which forces a Hot Storage lookup)
        const req = new Request('https://worker.local/api/admin/insight/outliers?timeframe=7', { method: 'GET' });
        const response = await handleAdminInsightRequest(req, env, ctx, new URL(req.url));
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.outliers.length).toBe(1);
        expect(data.outliers[0].student_hash).toBe('bad-kid-99');
        
        // 3. Ensure fetch WAS called and properly hit the Cloudflare API with the correct credentials
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        
        const fetchCallArgs = globalThis.fetch.mock.calls[0];
        const requestUrl = fetchCallArgs[0];
        const requestInit = fetchCallArgs[1];
        
        expect(requestUrl).toContain('api.cloudflare.com');
        expect(requestInit.headers['Authorization']).toBe('Bearer mock_api_token_abc');
        expect(requestInit.body).toContain("HAVING SUM(double1) >=");
    });

});