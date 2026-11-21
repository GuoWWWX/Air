CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    encrypted_yaml BLOB NOT NULL,
    encrypted_local_yaml BLOB
);

CREATE TABLE IF NOT EXISTS source_naming (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    automatic INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_name_aliases (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    base_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    system_proxy INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS startup_proxy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_overrides (
    node_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    server TEXT NOT NULL,
    port INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_details (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    encrypted_url BLOB,
    updated_at INTEGER NOT NULL,
    refresh_error TEXT,
    usage TEXT
);

CREATE TABLE IF NOT EXISTS subscription_updates (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL,
    hours INTEGER NOT NULL DEFAULT 24,
    custom_hours INTEGER,
    attempted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscription_extensions (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    definition BLOB NOT NULL,
    rendered BLOB NOT NULL
);

CREATE TRIGGER IF NOT EXISTS pause_subscription_edit AFTER UPDATE OF encrypted_local_yaml ON sources
WHEN NEW.encrypted_local_yaml IS NOT NULL BEGIN
    UPDATE subscription_updates SET enabled=0 WHERE source_id=NEW.id;
END;

CREATE TABLE IF NOT EXISTS probe_samples (
    node_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    PRIMARY KEY (node_id, revision, captured_at)
);
