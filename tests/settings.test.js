import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminSettingsRequest } from '../src/api/settings.js';

// Mock context for the worker
const ctx = {};

// ==========================================
// 🛠️ DATABASE SETUP HOOK
// ==========================================
beforeEach(async () => {
    // Wipe and recreate the system_settings table before every test
    const schema = `
        DROP TABLE IF EXISTS system_settings;
        CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, description TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        
        -- Insert the default value as defined in initial-schema.sql
        INSERT INTO system_settings (setting_key, setting_value, description) 
        VALUES ('insight_unapproved_threshold_minutes', '5', 'Minimum minutes spent on an unapproved site before it is logged');
    `;
    
    await env.DB.exec(schema);
});

describe('Settings API', () => {

    it('should successfully retrieve all system settings via GET', async () => {
        const req = new Request('https://worker.local/api/admin/settings', {
            method: 'GET'
        });
        
        const response = await handleAdminSettingsRequest(req, env, ctx, new URL(req.url));
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.settings).toBeDefined();
        expect(Array.isArray(data.settings)).toBe(true);
        expect(data.settings.length).toBe(1);
        
        // Verify default values
        expect(data.settings[0].setting_key).toBe('insight_unapproved_threshold_minutes');
        expect(data.settings[0].setting_value).toBe('5');
    });

    it('should successfully update existing settings via POST', async () => {
        // 1. Construct payload to change threshold from 5 to 15
        const payload = {
            settings: [
                { key: 'insight_unapproved_threshold_minutes', value: '15' }
            ]
        };

        const req = new Request('https://worker.local/api/admin/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // 2. Submit the request
        const response = await handleAdminSettingsRequest(req, env, ctx, new URL(req.url));
        const data = await response.json();

        // 3. Verify HTTP response
        expect(response.status).toBe(200);
        expect(data.success).toBe(true);

        // 4. Verify D1 Database state directly
        const dbResult = await env.DB.prepare(
            `SELECT setting_value FROM system_settings WHERE setting_key = 'insight_unapproved_threshold_minutes'`
        ).first();
        
        expect(dbResult.setting_value).toBe('15');
    });

    it('should reject malformed settings payloads', async () => {
        // Missing the 'settings' array wrapper
        const payload = {
            key: 'insight_unapproved_threshold_minutes', 
            value: '15'
        };

        const req = new Request('https://worker.local/api/admin/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const response = await handleAdminSettingsRequest(req, env, ctx, new URL(req.url));
        const data = await response.json();

        // Should hit the 400 Bad Request trap
        expect(response.status).toBe(400);
        expect(data.error).toBe("Invalid settings payload");
    });

});