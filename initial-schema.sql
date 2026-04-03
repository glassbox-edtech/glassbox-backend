-- ==========================================
-- GLASSBOX FILTER & INSIGHT SCHEMA
-- ==========================================

-- Tracks the current global version of the school's rule list
CREATE TABLE IF NOT EXISTS system_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_version INTEGER NOT NULL DEFAULT 1
);

-- The Master Rule Table (Filter Agent)
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,              -- The URL, domain, or path being blocked/allowed
    match_type TEXT DEFAULT 'domain',  -- 'domain' (all subdomains), 'host' (exact subdomain), or 'path'
    action TEXT NOT NULL,              -- 'block' or 'allow'
    version_added INTEGER NOT NULL,
    version_removed INTEGER,           -- NULL if currently active
    is_active BOOLEAN DEFAULT 1        -- 1 for active, 0 for removed
);

-- Unblock Requests from Students (Filter Agent)
CREATE TABLE IF NOT EXISTS unblock_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_hash TEXT NOT NULL,
    url TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'denied'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- NEW: INSIGHT AGENT TABLES
-- ==========================================

-- Tracks District Approved Apps for ROI calculation
CREATE TABLE IF NOT EXISTS approved_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,       -- e.g., 'ixl.com'
    app_name TEXT NOT NULL,            -- e.g., 'IXL Math'
    category TEXT,                     -- e.g., 'Education', 'Testing'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Batched time-tracking logs from the Insight Agent
CREATE TABLE IF NOT EXISTS insight_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_hash TEXT NOT NULL,
    target TEXT NOT NULL,              -- The domain or app URL
    minutes_spent REAL NOT NULL,       -- Time spent in active focus
    log_date DATE NOT NULL,            -- The day this activity occurred (YYYY-MM-DD)
    is_approved BOOLEAN DEFAULT 0,     -- 1 if it matches an approved_app, 0 for shadow IT
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Performance Indexes for Insight Logs (Crucial for fast Admin Dashboards)
CREATE INDEX IF NOT EXISTS idx_insight_logs_student ON insight_logs(student_hash);
CREATE INDEX IF NOT EXISTS idx_insight_logs_date ON insight_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_insight_logs_approved ON insight_logs(is_approved);

-- Global System Settings (Configurable by Admin)
CREATE TABLE IF NOT EXISTS system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- DEFAULT SYSTEM INITIALIZATION
-- ==========================================

-- Initialize the system state to version 1
INSERT OR IGNORE INTO system_state (id, current_version) VALUES (1, 1);

-- Initialize default Insight settings
INSERT OR IGNORE INTO system_settings (setting_key, setting_value, description) 
VALUES ('insight_unapproved_threshold_minutes', '5', 'Minimum minutes spent on an unapproved site before it is logged');