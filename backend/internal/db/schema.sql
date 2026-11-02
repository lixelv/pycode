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

-- A user's projects. The contents live in S3 under projects/<id>/; a deleted
-- row waits for the janitor, so a late upload is cleaned up too.
CREATE TABLE IF NOT EXISTS projects (
    id           uuid PRIMARY KEY,
    owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         text NOT NULL,
    settings     jsonb NOT NULL DEFAULT '{}',
    is_public    boolean NOT NULL DEFAULT false,
    size_bytes   bigint NOT NULL DEFAULT 0,
    copied_from  uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_name ON projects (owner_id, name) WHERE deleted_at IS NULL;

-- The room of a project: one current session per project, kept while it lives.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;

-- sha256 of a user's MCP token: the token itself is never stored.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mcp_token_hash bytea UNIQUE;
