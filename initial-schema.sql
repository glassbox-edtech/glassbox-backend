-- Tracks the current global version of the school's rule list
CREATE TABLE IF NOT EXISTS system_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_version INTEGER NOT NULL DEFAULT 1
);

-- The Master Rule Table
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,              -- The URL, domain, or path being blocked/allowed
    match_type TEXT DEFAULT 'domain',  -- 'domain' (all subdomains), 'host' (exact subdomain), or 'path'
    action TEXT NOT NULL,              -- 'block' or 'allow'
    version_added INTEGER NOT NULL,
    version_removed INTEGER,           -- NULL if currently active
    is_active BOOLEAN DEFAULT 1        -- 1 for active, 0 for removed
);

-- Unblock Requests from Students
CREATE TABLE IF NOT EXISTS unblock_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_hash TEXT NOT NULL,
    url TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'denied'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Initialize the system state to version 1
INSERT OR IGNORE INTO system_state (id, current_version) VALUES (1, 1);