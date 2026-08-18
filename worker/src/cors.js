/**
 * CORS configuration for the Cloudflare Worker API.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8000',
  'http://localhost:5000',
  'http://localhost:3000',
  'https://dsmnru-pyq.netlify.app',
  'https://lav-developer.github.io',
];

function getAllowedOrigins() {
  if (typeof ALLOWED_ORIGINS !== 'undefined' && ALLOWED_ORIGINS) {
    return ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function isOriginAllowed(origin) {
  if (!origin) return false;
  const allowed = getAllowedOrigins();
  return allowed.some((allowedOrigin) => {
    if (allowedOrigin.includes('*')) {
      const pattern = allowedOrigin.replace(/\*/g, '.*');
      return new RegExp(`^${pattern}$`).test(origin);
    }
    return origin === allowedOrigin;
  });
}

export function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  return headers;
}

export function handleOptions(request) {
  const headers = getCorsHeaders(request);
  return new Response(null, {
    status: 204,
    headers,
  });
}

export function withCors(request, response) {
  const corsHeaders = getCorsHeaders(request);
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
