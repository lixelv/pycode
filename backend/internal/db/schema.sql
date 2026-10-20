CREATE TABLE IF NOT EXISTS users (
    id          uuid PRIMARY KEY,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id           uuid PRIMARY KEY,
    code         text NOT NULL UNIQUE,
    owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode         text NOT NULL CHECK (mode IN ('read_only', 'read_write')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_active  timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz
);

-- Sessions no longer store content: the project lives in the owner's
-- browser and travels peer to peer (WebRTC).
DROP TABLE IF EXISTS session_updates;

CREATE INDEX IF NOT EXISTS sessions_last_active ON sessions (last_active);
