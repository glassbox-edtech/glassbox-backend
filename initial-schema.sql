-- ==========================================
-- GLASSBOX FILTER & INSIGHT SCHEMA
-- ==========================================

-- Tracks the current global version of the school's rule list
CREATE TABLE IF NOT EXISTS system_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_version INTEGER NOT NULL DEFAULT 1
);

-- ==========================================
-- NEW: MULTI-TENANCY & RBAC (ROLE-BASED ACCESS)
-- ==========================================

CREATE TABLE IF NOT EXISTS schools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delegated_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    role TEXT NOT NULL, -- 'teacher', 'school_admin'
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    token TEXT, -- For active session Bearer auth
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS students (
    student_hash TEXT PRIMARY KEY,
    school_id INTEGER NOT NULL,
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS classrooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    teacher_id INTEGER NOT NULL,
    name TEXT NOT NULL, -- e.g., 'Period 1 Math'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE,
    FOREIGN KEY (teacher_id) REFERENCES delegated_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS classroom_students (
    classroom_id INTEGER NOT NULL,
    student_hash TEXT NOT NULL,
    PRIMARY KEY (classroom_id, student_hash),
    FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
    FOREIGN KEY (student_hash) REFERENCES students(student_hash) ON DELETE CASCADE
);

-- ==========================================
-- FILTER TABLES
-- ==========================================

-- The Master Rule Table (Filter Agent)
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER DEFAULT 1,       -- 🎯 NEW: Scoped to specific school, 1 for global/default
    classroom_id INTEGER DEFAULT NULL, -- 🎯 NEW: Scoped to a specific teacher's period
    target TEXT NOT NULL,              -- The URL, domain, or path being blocked/allowed
    match_type TEXT DEFAULT 'domain',  -- 'domain' (all subdomains), 'host' (exact subdomain), or 'path'
    action TEXT NOT NULL,              -- 'block' or 'allow'
    version_added INTEGER NOT NULL,
    version_removed INTEGER,           -- NULL if currently active
    is_active BOOLEAN DEFAULT 1,       -- 1 for active, 0 for removed
    expires_at TIMESTAMP DEFAULT NULL  
);

-- Unblock Requests from Students (Filter Agent)
CREATE TABLE IF NOT EXISTS unblock_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER DEFAULT 1,       -- 🎯 NEW
    classroom_id INTEGER DEFAULT NULL, -- 🎯 NEW
    student_hash TEXT NOT NULL,
    url TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'denied'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stores Web Push API subscriptions for IT Admins
CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER DEFAULT 1,       -- 🎯 NEW: So pushes only go to the right admins
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- INSIGHT AGENT TABLES
-- ==========================================

-- Tracks District Approved Apps for ROI calculation
CREATE TABLE IF NOT EXISTS approved_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER DEFAULT 1,       -- 🎯 NEW: Schools can have different approved apps
    domain TEXT NOT NULL UNIQUE,       -- e.g., 'ixl.com'
    app_name TEXT NOT NULL,            -- e.g., 'IXL Math'
    category TEXT,                     -- e.g., 'Education', 'Testing'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

-- 🎯 NEW: Initialize the DEFAULT school so current extensions don't break
INSERT OR IGNORE INTO schools (id, name) VALUES (1, 'DEFAULT');

-- Initialize default Insight settings
INSERT OR IGNORE INTO system_settings (setting_key, setting_value, description) 
VALUES ('insight_unapproved_threshold_minutes', '5', 'Minimum minutes spent on an unapproved site before it is logged');