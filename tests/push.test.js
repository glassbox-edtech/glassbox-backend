import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { sendNativePush } from '../src/utils/push.js';

let validKeys;
let originalFetch;

// ------------------------------------------------------------------
// 🔐 CRYPTO HELPER: Generate valid P-256 keys dynamically for testing
// ------------------------------------------------------------------
async function generateValidKeys() {
    // 1. Generate Server VAPID Keys (ECDSA P-256)
    const vapidKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const vapidJwk = await crypto.subtle.exportKey('jwk', vapidKeyPair.privateKey);
    const vapidPubRaw = await crypto.subtle.exportKey('raw', vapidKeyPair.publicKey);
    const vapidPubB64 = btoa(String.fromCharCode(...new Uint8Array(vapidPubRaw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    
    // 2. Generate Browser Subscription Keys (ECDH P-256)
    const browserKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const browserPubRaw = await crypto.subtle.exportKey('raw', browserKeyPair.publicKey);
    const browserPubB64 = btoa(String.fromCharCode(...new Uint8Array(browserPubRaw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const browserAuth = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return {
        vapidJson: JSON.stringify({ publicKey: vapidPubB64, privateKey: vapidJwk.d }),
        p256dh: browserPubB64,
        auth: browserAuth
    };
}

beforeAll(async () => {
    validKeys = await generateValidKeys();
});

beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

describe('Native Web Push Encryption Engine (RFC 8291)', () => {

    it('should successfully dispatch an EMPTY ping (Content-Length: 0) without encryption', async () => {
        globalThis.fetch.mockResolvedValue(new Response('Created', { status: 201 }));

        const subscription = { endpoint: 'https://web-push.local/ping', keys: { p256dh: validKeys.p256dh, auth: validKeys.auth } };
        
        // Pass NULL as the payload
        const response = await sendNativePush(subscription, null, validKeys.vapidJson);
        
        expect(response.status).toBe(201);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);

        const fetchCall = globalThis.fetch.mock.calls[0];
        const headers = fetchCall[1].headers;
        
        // Verify it bypassed payload math
        expect(headers['Content-Length']).toBe('0');
        expect(headers['Authorization']).toContain('vapid t=');
        expect(fetchCall[1].body).toBeNull();
    });

    it('should successfully ENCRYPT a JSON payload using AES-128-GCM and format the binary array', async () => {
        globalThis.fetch.mockResolvedValue(new Response('Created', { status: 201 }));

        const subscription = { endpoint: 'https://web-push.local/encrypted', keys: { p256dh: validKeys.p256dh, auth: validKeys.auth } };
        const payloadString = JSON.stringify({ message: "Hello, securely!" });
        
        const response = await sendNativePush(subscription, payloadString, validKeys.vapidJson);
        
        expect(response.status).toBe(201);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);

        const fetchCall = globalThis.fetch.mock.calls[0];
        const headers = fetchCall[1].headers;
        const body = fetchCall[1].body; // This is the Uint8Array
        
        // 1. Verify Headers
        expect(headers['Content-Encoding']).toBe('aes128gcm');
        expect(headers['Content-Type']).toBe('application/octet-stream');
        expect(headers['Authorization']).toContain('vapid t=');

        // 2. Verify Binary Array Structure (RFC 8291 specs)
        expect(body).toBeInstanceOf(Uint8Array);
        // Minimum length: 16 (Salt) + 4 (Record Size) + 1 (Key Length) + 65 (Public Key) = 86 bytes header + encrypted payload
        expect(body.length).toBeGreaterThan(86);
        expect(body[20]).toBe(65); // Byte 20 MUST specify that the Ephemeral Public Key is 65 bytes long
    });

    it('should throw a standardized error with a statusCode on HTTP failures (e.g., 410 Gone)', async () => {
        globalThis.fetch.mockResolvedValue(new Response('Gone', { status: 410 }));

        const subscription = { endpoint: 'https://web-push.local/dead', keys: { p256dh: validKeys.p256dh, auth: validKeys.auth } };
        
        try {
            await sendNativePush(subscription, "Test", validKeys.vapidJson);
            // Force a failure if it somehow passes
            expect(true).toBe(false); 
        } catch (err) {
            expect(err.statusCode).toBe(410);
            expect(err.message).toContain('Push failed: 410');
        }
    });

});