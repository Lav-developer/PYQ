/**
 * Firestore OAuth2 authentication for Cloudflare Workers.
 * Generates short-lived access tokens from a Google service account
 * using the JWT bearer flow and the Web Crypto API.
 */

let cachedToken = null;
let tokenExpiry = 0;

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

export async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && tokenExpiry > now + 300) {
    return cachedToken;
  }

  const serviceAccountJson = FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  }

  let sa;
  try {
    sa = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  const { client_email, private_key } = sa;
  if (!client_email || !private_key) {
    throw new Error('Service account missing client_email or private_key');
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encode = (obj) => base64UrlEncode(JSON.stringify(obj));
  const message = `${encode(header)}.${encode(claim)}`;

  const keyData = pemToArrayBuffer(private_key);
  let key;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
      false,
      ['sign']
    );
  } catch (err) {
    throw new Error(`Failed to import private key: ${err.message}`);
  }

  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(message)
  );

  const jwt = `${message}.${base64UrlEncodeBuffer(signature)}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error(`OAuth2 token exchange failed: ${tokenResponse.status} ${errText}`);
  }

  const tokenData = await tokenResponse.json();
  cachedToken = tokenData.access_token;
  tokenExpiry = now + (tokenData.expires_in || 3600) - 60;

  return cachedToken;
}

export function clearTokenCache() {
  cachedToken = null;
  tokenExpiry = 0;
}
