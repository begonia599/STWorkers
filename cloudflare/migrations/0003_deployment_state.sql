CREATE TABLE IF NOT EXISTS stworkers_deployment_state (
    id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
