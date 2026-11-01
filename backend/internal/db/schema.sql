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

-- Asked for a name on joining (set when the session starts).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ask_name boolean NOT NULL DEFAULT false;

-- One join code per role: the built-in read/write/admin and custom roles.
-- sessions.code is the write code (kept for the unique session link).
CREATE TABLE IF NOT EXISTS session_codes (
    code        text PRIMARY KEY,
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        text NOT NULL,
    level       text NOT NULL CHECK (level IN ('read', 'write', 'admin')),
    UNIQUE (session_id, role)
);

-- Level and custom roles given by the owner or an admin during a session;
-- they win over the join code, so reconnecting does not undo them.
CREATE TABLE IF NOT EXISTS session_members (
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    level       text NOT NULL CHECK (level IN ('read', 'write', 'admin')),
    roles       text[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (session_id, user_id)
);

-- Users an owner or an admin banned from a session: they are refused on joining.
CREATE TABLE IF NOT EXISTS session_bans (
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    PRIMARY KEY (session_id, user_id)
);
