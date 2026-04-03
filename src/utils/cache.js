// ⚡ THE SINGLE WRITER PRINCIPLE
// This is the ONLY function allowed to write to the master_rules KV cache.
// It will be called by the Admin API (on block/approve) and the Cron Job.

export async function rebuildMasterRulesCache(env, ctx) {
    console.log("Rebuilding master_rules KV Cache...");
    try {
        // 1. Get the absolute latest data from D1
        const state = await env.DB.prepare(`SELECT current_version FROM system_state WHERE id = 1`).first();
        const { results } = await env.DB.prepare(
            `SELECT id, target, match_type, action FROM rules WHERE is_active = 1`
        ).all();
        
        const fullState = { version: state.current_version, rules: results };
        
        // 2. Prepare the write operation
        const cachePromise = env.GLASSBOX_KV.put("master_rules", JSON.stringify(fullState));
        
        // 3. Non-blocking execution
        // If we have a context (like during an Admin API request), use waitUntil 
        // so the Admin doesn't have to wait for the KV write to finish.
        if (ctx && ctx.waitUntil) {
            ctx.waitUntil(cachePromise);
        } else {
            // Fallback for Cron jobs
            await cachePromise; 
        }
        
        console.log(`✅ KV Cache successfully updated to version ${state.current_version}`);
        return fullState;

    } catch (err) {
        console.error("❌ Failed to rebuild KV cache:", err);
        throw err; // Bubble the error up so the caller knows it failed
    }
}