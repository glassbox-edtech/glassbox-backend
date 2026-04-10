-- ==============================================================================
-- 📊 GLASSBOX TELEMETRY DATABASE (Warm Storage Rollups)
-- ==============================================================================

DROP TABLE IF EXISTS daily_rollups;

CREATE TABLE IF NOT EXISTS daily_rollups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER DEFAULT 1,       -- 🎯 NEW: Multi-tenancy isolation
    log_date TEXT NOT NULL,        
    target TEXT NOT NULL,          
    status TEXT NOT NULL,          
    total_minutes REAL DEFAULT 0,  
    total_hits INTEGER DEFAULT 0,  
    unique_students INTEGER DEFAULT 0, 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- 🎯 CRITICAL FIX: Added school_id to the unique constraint to prevent cross-school overwrites
    UNIQUE(school_id, log_date, target, status)
);

CREATE INDEX IF NOT EXISTS idx_rollups_date ON daily_rollups(log_date);
CREATE INDEX IF NOT EXISTS idx_rollups_target ON daily_rollups(target);
CREATE INDEX IF NOT EXISTS idx_rollups_school ON daily_rollups(school_id);