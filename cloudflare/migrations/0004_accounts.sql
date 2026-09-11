CREATE TABLE IF NOT EXISTS stworkers_accounts (
    handle TEXT PRIMARY KEY CHECK (handle = 'owner'),
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    bootstrap_hash TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stworkers_sessions (
    token_hash TEXT PRIMARY KEY,
    handle TEXT NOT NULL REFERENCES stworkers_accounts(handle) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    csrf TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stworkers_sessions_expiry ON stworkers_sessions(expires_at);

CREATE TABLE IF NOT EXISTS stworkers_login_limits (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL
);
