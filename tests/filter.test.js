import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleFilterRequest, handleAdminFilterRequest } from '../src/api/filter.js';

// Mock context for the worker (simulates ctx.waitUntil for background caching)
const ctx = {
    waitUntil: (promise) => promise
};

// ==========================================
// 🛠️ DATABASE SETUP HOOK
// ==========================================
beforeEach(async () => {
    // 1. Wipe the in-memory D1 database clean
    const schema = `
        DROP TABLE IF EXISTS system_state;
        DROP TABLE IF EXISTS rules;
        DROP TABLE IF EXISTS unblock_requests;
        DROP TABLE IF EXISTS admin_push_subscriptions;

        CREATE TABLE system_state (id INTEGER PRIMARY KEY CHECK (id = 1), current_version INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE rules (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, match_type TEXT DEFAULT 'domain', action TEXT NOT NULL, version_added INTEGER NOT NULL, version_removed INTEGER, is_active BOOLEAN DEFAULT 1);
        CREATE TABLE unblock_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, student_hash TEXT NOT NULL, url TEXT NOT NULL, reason TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE admin_push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);

        INSERT INTO system_state (id, current_version) VALUES (1, 1);
    `;
    
    // Execute the raw schema against the in-memory D1 test binding
    await env.DB.exec(schema);

    // 2. Clear out the in-memory KV cache
    await env.GLASSBOX_KV.delete("master_rules");
});


describe('Filter API - Student Routes', () => {

    it('should successfully submit an unblock request', async () => {
        // 1. Construct the mock request
        const payload = {
            studentHash: 'abc-123-xyz',
            url: 'https://mathgames.com',
            reason: 'Needed for homework'
        };
        const req = new Request('https://worker.local/api/filter/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const url = new URL(req.url);

        // 2. Pass it to your handler
        const response = await handleFilterRequest(req, env, url);
        const data = await response.json();

        // 3. Verify HTTP response
        expect(response.status).toBe(200);
        expect(data.success).toBe(true);

        // 4. Verify D1 Database state directly
        const dbResult = await env.DB.prepare(`SELECT * FROM unblock_requests`).all();
        expect(dbResult.results.length).toBe(1);
        expect(dbResult.results[0].student_hash).toBe('abc-123-xyz');
        expect(dbResult.results[0].status).toBe('pending');
    });

    it('should reject malformed unblock requests', async () => {
        const req = new Request('https://worker.local/api/filter/request', {
            method: 'POST',
            body: JSON.stringify({ url: 'missing-student-hash.com' })
        });
        
        const response = await handleFilterRequest(req, env, new URL(req.url));
        expect(response.status).toBe(400);
    });

    // 🧹 NEW TEST: Push Notification Cleanup (Updated for Native Crypto)
    it('should dispatch push notifications and automatically delete dead endpoints (404/410)', async () => {
        // 1. Generate cryptographically valid keys so the native crypto engine doesn't crash
        const vapidKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const vapidJwk = await crypto.subtle.exportKey('jwk', vapidKeyPair.privateKey);
        const vapidPubRaw = await crypto.subtle.exportKey('raw', vapidKeyPair.publicKey);
        const vapidPubB64 = btoa(String.fromCharCode(...new Uint8Array(vapidPubRaw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        
        const browserKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const browserPubRaw = await crypto.subtle.exportKey('raw', browserKeyPair.publicKey);
        const browserPubB64 = btoa(String.fromCharCode(...new Uint8Array(browserPubRaw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const browserAuth = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        env.VAPID_KEYS = JSON.stringify({ publicKey: vapidPubB64, privateKey: vapidJwk.d });

        // 2. Mock global fetch to simulate push server responses (Success vs Gone)
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (url) => {
            if (url.includes('invalid-push')) {
                return new Response('Gone', { status: 410 });
            }
            return new Response('Created', { status: 201 });
        });

        // 3. Seed the DB with 1 good subscription and 2 bad subscriptions using batch for reliability
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO admin_push_subscriptions (endpoint, p256dh, auth) VALUES ('https://web-push.local/good-push', ?, ?)`).bind(browserPubB64, browserAuth),
            env.DB.prepare(`INSERT INTO admin_push_subscriptions (endpoint, p256dh, auth) VALUES ('https://web-push.local/invalid-push1', ?, ?)`).bind(browserPubB64, browserAuth),
            env.DB.prepare(`INSERT INTO admin_push_subscriptions (endpoint, p256dh, auth) VALUES ('https://web-push.local/invalid-push2', ?, ?)`).bind(browserPubB64, browserAuth)
        ]);

        // 4. Trigger a student unblock request (which fires the push notifications)
        const payload = {
            studentHash: 'clean-up-test-hash',
            url: 'https://test.com',
            reason: 'Testing the push cleanup logic'
        };
        const req = new Request('https://worker.local/api/filter/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        await handleFilterRequest(req, env, new URL(req.url));

        // Restore global fetch
        globalThis.fetch = originalFetch;

        // 5. Verify the database automatically pruned the two bad endpoints
        const dbResult = await env.DB.prepare(`SELECT endpoint FROM admin_push_subscriptions`).all();
        
        expect(dbResult.results.length).toBe(1);
        expect(dbResult.results[0].endpoint).toBe('https://web-push.local/good-push');
    });

});


describe('Filter API - Admin Routes', () => {

    it('should approve a request, insert a rule, increment version, and update KV', async () => {
        // 1. Seed a pending request into D1
        const insertReq = await env.DB.prepare(
            `INSERT INTO unblock_requests (student_hash, url, reason) VALUES ('123', 'coolmath.com', 'game') RETURNING id`
        ).first();
        const pendingId = insertReq.id;

        // 2. Submit the Admin Approval
        const req = new Request('https://worker.local/api/admin/filter/resolve', {
            method: 'POST',
            body: JSON.stringify({ requestId: pendingId, action: 'approve', target: 'coolmath.com', matchType: 'domain' })
        });
        
        const response = await handleAdminFilterRequest(req, env, ctx, new URL(req.url));
        expect(response.status).toBe(200);

        // 3. Assert Unblock Request changed to 'approved'
        const reqState = await env.DB.prepare(`SELECT status FROM unblock_requests WHERE id = ?`).bind(pendingId).first();
        expect(reqState.status).toBe('approved');

        // 4. Assert System Version Incremented to 2
        const sysState = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
        expect(sysState.current_version).toBe(2);

        // 5. Assert Rule was Injected
        const ruleCheck = await env.DB.prepare(`SELECT target, action, version_added FROM rules`).all();
        expect(ruleCheck.results.length).toBe(1);
        expect(ruleCheck.results[0].target).toBe('coolmath.com');
        expect(ruleCheck.results[0].action).toBe('allow');
        expect(ruleCheck.results[0].version_added).toBe(2);

        // 6. Assert KV Cache was Rebuilt
        const kvState = await env.GLASSBOX_KV.get('master_rules', { type: 'json' });
        expect(kvState.version).toBe(2);
        expect(kvState.rules[0].target).toBe('coolmath.com');
    });

    it('should properly process manual domain blocks', async () => {
        const payload = {
            domains: ['badsite.com', 'malware.net']
        };
        const req = new Request('https://worker.local/api/admin/filter/block', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const response = await handleAdminFilterRequest(req, env, ctx, new URL(req.url));
        expect(response.status).toBe(200);

        const rules = await env.DB.prepare(`SELECT target, action FROM rules WHERE is_active = 1`).all();
        expect(rules.results.length).toBe(2);
        expect(rules.results[0].action).toBe('block');
    });

});


describe('Filter API - Sync Engine', () => {

    it('should return up_to_date if versions match', async () => {
        const req = new Request('https://worker.local/api/filter/sync?version=1', { method: 'GET' });
        const response = await handleFilterRequest(req, env, new URL(req.url));
        const data = await response.json();
        
        expect(data.status).toBe('up_to_date');
    });

    it('should return delta_success with proper arrays when outdated', async () => {
        // 1. Manually bump server version and add an active rule and an inactive rule
        await env.DB.exec(`
            UPDATE system_state SET current_version = 3 WHERE id = 1;
            INSERT INTO rules (target, action, version_added, is_active) VALUES ('newsite.com', 'block', 2, 1);
            INSERT INTO rules (target, action, version_added, version_removed, is_active) VALUES ('oldsite.com', 'allow', 1, 3, 0);
        `);

        // 2. Poll as version 1
        const req = new Request('https://worker.local/api/filter/sync?version=1', { method: 'GET' });
        const response = await handleFilterRequest(req, env, new URL(req.url));
        const data = await response.json();

        expect(data.status).toBe('delta_success');
        expect(data.version).toBe(3);
        
        // Ensure 'newsite.com' is in added
        expect(data.added.length).toBe(1);
        expect(data.added[0].target).toBe('newsite.com');
        
        // Ensure 'oldsite.com' ID is in removed
        expect(data.removed.length).toBe(1);
    });

    it('should force a full sync if gap is larger than 50 versions or version is 0', async () => {
        // Jump the server ahead 60 versions
        await env.DB.exec(`UPDATE system_state SET current_version = 61 WHERE id = 1;`);

        // Client on version 1 is 60 versions behind
        const req = new Request('https://worker.local/api/filter/sync?version=1', { method: 'GET' });
        const response = await handleFilterRequest(req, env, new URL(req.url));
        const data = await response.json();

        expect(data.status).toBe('full_sync_required');
    });

});