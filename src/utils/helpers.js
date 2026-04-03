// Standard CORS headers for API requests
export const corsHeaders = {
    "Access-Control-Allow-Origin": "*", 
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
  
// Cache headers to leverage Cloudflare's Edge CDN (The "Cheat Code")
export const cacheHeaders = {
    ...corsHeaders,
    "Cache-Control": "public, max-age=60, s-maxage=60" 
};

// A simple helper to standardize JSON error responses
export function jsonError(message, status = 400) {
    return Response.json({ error: message }, { status: status, headers: corsHeaders });
}