import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index.js';

// Mock context for background tasks
const ctx = {
    waitUntil: (promise) => promise
};

// Save the original fetch to restore it later
const originalFetch = globalThis.fetch;

// ==========================================
// 🛠️ DATABASE & ENV SETUP HOOK
// ==========================================
beforeEach(async () => {
    // 1. Wipe and recreate Main DB tables
    await env.DB.batch([
        env.DB.prepare(`DROP TABLE IF EXISTS system_state`),
        env.DB.prepare(`DROP TABLE IF EXISTS rules`),
        env.DB.prepare(`DROP TABLE IF EXISTS unblock_requests`),
        
        env.DB.prepare(`CREATE TABLE system_state (id INTEGER PRIMARY KEY CHECK (id = 1), current_version INTEGER NOT NULL DEFAULT 1)`),
        env.DB.prepare(`CREATE TABLE rules (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, match_type TEXT DEFAULT 'domain', action TEXT NOT NULL, version_added INTEGER NOT NULL, version_removed INTEGER, is_active BOOLEAN DEFAULT 1)`),
        env.DB.prepare(`CREATE TABLE unblock_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, student_hash TEXT NOT NULL, url TEXT NOT NULL, reason TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`),
        
        // Seed system state to version 60 so we can test the "current_version - 50" cleanup logic
        env.DB.prepare(`INSERT INTO system_state (id, current_version) VALUES (1, 60)`)
    ]);

    // 2. Wipe and recreate Telemetry DB table
    // 🎯 CRITICAL: Must include UNIQUE constraint for ON CONFLICT DO UPDATE to work!
    await env.TELEMETRY_DB.batch([
        env.TELEMETRY_DB.prepare(`DROP TABLE IF EXISTS daily_rollups`),
        env.TELEMETRY_DB.prepare(`
            CREATE TABLE daily_rollups (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                log_date TEXT NOT NULL, 
                target TEXT NOT NULL, 
                status TEXT NOT NULL, 
                total_minutes REAL DEFAULT 0, 
                total_hits INTEGER DEFAULT 0, 
                unique_students INTEGER DEFAULT 0,
                UNIQUE(log_date, target, status)
            )
        `)
    ]);

    // 3. Clear KV Cache
    await env.GLASSBOX_KV.delete("master_rules");

    // 4. Mock global fetch and environment variables
    globalThis.fetch = vi.fn();
    env.CF_ACCOUNT_ID = "mock_account_id_123";
    env.CF_API_TOKEN = "mock_api_token_abc";
    env.SCHOOL_TIMEZONE = "UTC";
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers(); // Release the frozen clock!
    vi.restoreAllMocks();
});

// ==========================================
// 🧹 ROUTINE CLEANUP CRON (15 Mins)
// ==========================================
describe('Cron Job - 15-Minute Cleanup', () => {

    it('should successfully purge stale rules and old unblock requests', async () => {
        // 1. Seed the DB with a mix of old (should delete) and new (should keep) records
        await env.DB.batch([
            // Rule removed at version 5 (Older than current version 60 - 50 = cutoff 10) -> SHOULD DELETE
            env.DB.prepare(`INSERT INTO rules (target, action, version_added, version_removed, is_active) VALUES ('old-rule.com', 'block', 1, 5, 0)`),
            // Rule removed at version 15 (Newer than cutoff 10) -> SHOULD KEEP
            env.DB.prepare(`INSERT INTO rules (target, action, version_added, version_removed, is_active) VALUES ('new-rule.com', 'block', 10, 15, 0)`),
            
            // Request 40 days old -> SHOULD DELETE
            env.DB.prepare(`INSERT INTO unblock_requests (student_hash, url, reason, status, created_at) VALUES ('hash1', 'old-req.com', 'pls', 'approved', date('now', '-40 days'))`),
            // Request 5 days old -> SHOULD KEEP
            env.DB.prepare(`INSERT INTO unblock_requests (student_hash, url, reason, status, created_at) VALUES ('hash2', 'new-req.com', 'pls', 'denied', date('now', '-5 days'))`)
        ]);

        // 2. Trigger the cron
        await worker.scheduled({ cron: "*/15 * * * *" }, env, ctx);

        // 3. Assert Rules
        const rules = await env.DB.prepare(`SELECT target FROM rules`).all();
        expect(rules.results.length).toBe(1);
        expect(rules.results[0].target).toBe('new-rule.com');

        // 4. Assert Requests
        const reqs = await env.DB.prepare(`SELECT url FROM unblock_requests`).all();
        expect(reqs.results.length).toBe(1);
        expect(reqs.results[0].url).toBe('new-req.com');
    });

});

// ==========================================
// ⏰ MIDNIGHT ROLLUP CRON (Hourly)
// ==========================================
describe('Cron Job - Hourly Tick-Tock & Midnight Rollup', () => {

    it('should quietly skip execution if the local time is not midnight', async () => {
        // 1. Freeze time to exactly 2:00 PM (14:00) UTC
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-08T14:00:00Z'));

        // 2. Trigger the hourly cron
        await worker.scheduled({ cron: "0 * * * *" }, env, ctx);

        // 3. Verify it skipped the heavy work
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should execute the rollup query and insert into Telemetry D1 at exact local midnight', async () => {
        // 1. Freeze time to exactly 00:00 AM UTC (Midnight)
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-08T00:00:00Z'));

        // 2. Mock a successful Analytics Engine API response
        const mockCfResponse = {
            data: [
                { target: 'coolmathgames.com', status: 'unapproved', total_minutes: 120, total_hits: 50, unique_students: 10 }
            ]
        };
        globalThis.fetch.mockResolvedValue(new Response(JSON.stringify(mockCfResponse), { status: 200 }));

        // 3. Trigger the hourly cron
        await worker.scheduled({ cron: "0 * * * *" }, env, ctx);

        // 4. Verify the Fetch call occurred
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);

        const fetchCallArgs = globalThis.fetch.mock.calls[0];
        const requestBody = fetchCallArgs[1].body;
        
        // Assert our exact time bounds were passed to the SQL query
        expect(requestBody).toContain('2026-04-07 00:00:00'); // Start Time
        expect(requestBody).toContain('2026-04-08 00:00:00'); // End Time

        // 5. Verify the results were successfully committed to D1
        const rollups = await env.TELEMETRY_DB.prepare(`SELECT * FROM daily_rollups`).all();
        expect(rollups.results.length).toBe(1);
        expect(rollups.results[0].target).toBe('coolmathgames.com');
        expect(rollups.results[0].total_minutes).toBe(120);
        expect(rollups.results[0].unique_students).toBe(10);
    });

});