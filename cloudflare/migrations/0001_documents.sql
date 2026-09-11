CREATE TABLE IF NOT EXISTS documents (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (kind, id)
);
