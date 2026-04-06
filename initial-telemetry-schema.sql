-- ==============================================================================
-- 📊 GLASSBOX TELEMETRY DATABASE (Warm Storage Rollups)
-- ==============================================================================

DROP TABLE IF EXISTS daily_rollups;

CREATE TABLE IF NOT EXISTS daily_rollups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,        
    target TEXT NOT NULL,          
    status TEXT NOT NULL,          
    total_minutes REAL DEFAULT 0,  
    total_hits INTEGER DEFAULT 0,  
    unique_students INTEGER DEFAULT 0, -- 🎯 NEW: Tracks unique users per target
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- 🎯 CRITICAL FIX: Added status to the unique constraint
    UNIQUE(log_date, target, status)
);

CREATE INDEX IF NOT EXISTS idx_rollups_date ON daily_rollups(log_date);
CREATE INDEX IF NOT EXISTS idx_rollups_target ON daily_rollups(target);