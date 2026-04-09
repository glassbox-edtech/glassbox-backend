// ============================================================================
// 🔔 EDGE-NATIVE WEB PUSH NOTIFICATIONS (RFC 8291 / RFC 8188)
// Zero Dependencies. Full AES-128-GCM Payload Encryption using WebCrypto.
// ============================================================================

function base64urlToUint8Array(base64url) {
    const padding = '='.repeat((4 - base64url.length % 4) % 4);
    const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function uint8ArrayToBase64url(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- HKDF MATH HELPERS ---
async function hmac(key, data) {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

async function hkdfExpand(prk, info, length) {
    // RFC 5869 HKDF-Expand specifically for lengths <= 32 (1 block)
    const data = new Uint8Array(info.length + 1);
    data.set(info);
    data[info.length] = 1;
    const hash = await hmac(prk, data);
    return hash.slice(0, length);
}

// --- MAIN PUSH FUNCTION ---
export async function sendNativePush(subscription, payloadString, vapidKeysJson) {
    const keys = JSON.parse(vapidKeysJson);
    const endpoint = subscription.endpoint;
    const origin = new URL(endpoint).origin;

    // ---------------------------------------------------------
    // 1. GENERATE VAPID JWT AUTHORIZATION
    // ---------------------------------------------------------
    const vapidPubBuf = base64urlToUint8Array(keys.publicKey);
    const vapidJwk = {
        kty: 'EC', crv: 'P-256',
        x: uint8ArrayToBase64url(vapidPubBuf.slice(1, 33)),
        y: uint8ArrayToBase64url(vapidPubBuf.slice(33, 65)),
        d: keys.privateKey, ext: true
    };
    const vapidCryptoKey = await crypto.subtle.importKey(
        'jwk', vapidJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    );
    const header = uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const jwtPayload = uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify({
        aud: origin, exp: Math.floor(Date.now() / 1000) + (12 * 60 * 60), sub: 'mailto:admin@glassbox.local'
    })));
    const unsignedToken = `${header}.${jwtPayload}`;
    const signatureBuffer = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, vapidCryptoKey, new TextEncoder().encode(unsignedToken)
    );
    const jwt = `${unsignedToken}.${uint8ArrayToBase64url(signatureBuffer)}`;

    // ---------------------------------------------------------
    // 2. PREPARE HTTP REQUEST
    // ---------------------------------------------------------
    let body = null;
    let headers = {
        'Authorization': `vapid t=${jwt}, k=${keys.publicKey}`,
        'TTL': '3600'
    };

    // ---------------------------------------------------------
    // 3. RFC 8291 PAYLOAD ENCRYPTION (If payload is provided)
    // ---------------------------------------------------------
    if (payloadString) {
        const clientPubKey = base64urlToUint8Array(subscription.keys.p256dh);
        const clientAuthSecret = base64urlToUint8Array(subscription.keys.auth);

        // A. Generate Ephemeral ECDH Keypair
        const ephemeralKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const ephemeralPubKeyBuf = await crypto.subtle.exportKey('raw', ephemeralKeys.publicKey);
        const ephemeralPubKey = new Uint8Array(ephemeralPubKeyBuf);

        // B. Import Client Public Key & Derive Shared Secret
        const clientJwk = {
            kty: 'EC', crv: 'P-256',
            x: uint8ArrayToBase64url(clientPubKey.slice(1, 33)),
            y: uint8ArrayToBase64url(clientPubKey.slice(33, 65)),
            ext: true
        };
        const clientCryptoKey = await crypto.subtle.importKey(
            'jwk', clientJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []
        );
        const sharedSecretBuf = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: clientCryptoKey }, ephemeralKeys.privateKey, 256
        );
        const sharedSecret = new Uint8Array(sharedSecretBuf);

        // C. Cryptographic Salt & HKDF Math
        const salt = crypto.getRandomValues(new Uint8Array(16));
        
        // HKDF-Extract using the client's auth secret as the salt
        const prkKey = await hmac(clientAuthSecret, sharedSecret);
        
        // Assemble WebPush Context
        const infoStr = new TextEncoder().encode("WebPush: info\0");
        const context = new Uint8Array(infoStr.length + clientPubKey.length + ephemeralPubKey.length);
        context.set(infoStr, 0);
        context.set(clientPubKey, infoStr.length);
        context.set(ephemeralPubKey, infoStr.length + clientPubKey.length);

        // HKDF-Expand into Input Keying Material (IKM)
        const ikm = await hkdfExpand(prkKey, context, 32);

        // 🎯 FIX: SECOND HKDF-Extract! RFC 8188 requires mixing the 16-byte random salt 
        // with the IKM to generate the final Content PRK.
        const contentPrk = await hmac(salt, ikm);

        // Derive AES Content Encryption Key (CEK) & Nonce
        const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
        const cekBuf = await hkdfExpand(contentPrk, cekInfo, 16);
        const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");
        const nonce = await hkdfExpand(contentPrk, nonceInfo, 12);

        // D. AES-128-GCM Encryption
        const cek = await crypto.subtle.importKey(
            'raw', cekBuf, { name: 'AES-GCM' }, false, ['encrypt']
        );

        // Plaintext must end with a 0x02 byte (RFC 8188 padding delimiter)
        const plaintextBytes = new TextEncoder().encode(payloadString);
        const recordPlaintext = new Uint8Array(plaintextBytes.length + 1);
        recordPlaintext.set(plaintextBytes, 0);
        recordPlaintext[plaintextBytes.length] = 0x02; 

        // 🎯 FIX: Added explicit tagLength to ensure universal browser compatibility
        const encryptedPayloadBuf = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, recordPlaintext
        );
        const encryptedPayload = new Uint8Array(encryptedPayloadBuf);

        // E. Assemble Final Binary Packet
        const message = new Uint8Array(16 + 4 + 1 + 65 + encryptedPayload.length);
        message.set(salt, 0);
        // Record Size: 4096 (0x1000) -> [0, 0, 16, 0] in uint32 network byte order
        message.set([0, 0, 16, 0], 16);
        message[20] = 65; // Ephemeral Public Key Length
        message.set(ephemeralPubKey, 21);
        message.set(encryptedPayload, 86);

        // F. Set Payload Headers
        body = message;
        headers['Content-Encoding'] = 'aes128gcm';
        headers['Content-Type'] = 'application/octet-stream';
    } else {
        headers['Content-Length'] = '0'; // Support for empty pings
    }

    // ---------------------------------------------------------
    // 4. DISPATCH THE REQUEST
    // ---------------------------------------------------------
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: body
    });

    if (!response.ok) {
        const errText = await response.text();
        const error = new Error(`Push failed: ${response.status} - ${errText}`);
        error.statusCode = response.status;
        throw error;
    }

    return response;
}