-- ==============================================================================
-- 📊 GLASSBOX TELEMETRY DATABASE (Warm Storage Rollups)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS daily_rollups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,        -- Format: YYYY-MM-DD
    student_hash TEXT NOT NULL,    -- Anonymous student identifier
    target TEXT NOT NULL,          -- The domain or specific URL path
    status TEXT NOT NULL,          -- 'approved' or 'unapproved'
    total_minutes REAL DEFAULT 0,  -- Time spent (from time_logs)
    total_hits INTEGER DEFAULT 0,  -- Number of visits (from hit_logs)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- This UNIQUE constraint prevents duplicating data if the cron job ever accidentally runs twice for the same day
    UNIQUE(log_date, student_hash, target)
);

-- 🚀 PERFORMANCE INDEXES
-- These are critical because this table will grow massive over a year.
-- Indexes allow the dashboard to instantly filter without scanning millions of rows.
CREATE INDEX IF NOT EXISTS idx_rollups_date ON daily_rollups(log_date);
CREATE INDEX IF NOT EXISTS idx_rollups_hash ON daily_rollups(student_hash);
CREATE INDEX IF NOT EXISTS idx_rollups_target ON daily_rollups(target);