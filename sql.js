[
            sql`
                CREATE TABLE IF NOT EXISTS users (
                    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    name            VARCHAR(255) NOT NULL,
                    email           VARCHAR(255) UNIQUE NOT NULL,
                    password        VARCHAR(255) NOT NULL,
                    storage_used    BIGINT NOT NULL DEFAULT 0,
                    storage_limit   BIGINT NOT NULL DEFAULT 1073741824,
                    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `,
            sql`
                CREATE TABLE IF NOT EXISTS folders (
                    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    name        VARCHAR(255) NOT NULL,
                    parent_id   UUID REFERENCES folders(id) ON DELETE SET NULL DEFAULT NULL,
                    owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    path        UUID[] NOT NULL DEFAULT '{}'::uuid[],
                    is_trashed  BOOLEAN NOT NULL DEFAULT FALSE,
                    trashed_at  TIMESTAMPTZ DEFAULT NULL,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `,
            sql`
                CREATE TABLE IF NOT EXISTS files (
                    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    name          VARCHAR(255) NOT NULL,
                    original_name VARCHAR(255) NOT NULL,
                    mime_type     VARCHAR(128) NOT NULL,
                    size          BIGINT NOT NULL,
                    s3_key        VARCHAR(512) UNIQUE NOT NULL,
                    folder_id     UUID REFERENCES folders(id) ON DELETE SET NULL DEFAULT NULL,
                    owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    is_trashed    BOOLEAN NOT NULL DEFAULT FALSE,
                    trashed_at    TIMESTAMPTZ DEFAULT NULL,
                    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `,
            sql`
                CREATE TABLE IF NOT EXISTS share_links (
                    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    token         VARCHAR(64) UNIQUE NOT NULL,
                    resource_type VARCHAR(20) NOT NULL,
                    resource_id   UUID NOT NULL,
                    owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    permission    VARCHAR(20) NOT NULL DEFAULT 'download',
                    expires_at    TIMESTAMPTZ DEFAULT NULL,
                    access_count  INT NOT NULL DEFAULT 0,
                    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT unique_resource_owner UNIQUE (resource_id, owner_id)
                )
            `,
            sql`CREATE INDEX IF NOT EXISTS idx_folders_owner_parent  ON folders (owner_id, parent_id, is_trashed)`,
            sql`CREATE INDEX IF NOT EXISTS idx_folders_owner_trashed ON folders (owner_id, is_trashed)`,
            sql`CREATE INDEX IF NOT EXISTS idx_folders_path          ON folders USING GIN (path)`,
            sql`CREATE INDEX IF NOT EXISTS idx_files_owner_folder         ON files (owner_id, folder_id, is_trashed)`,
            sql`CREATE INDEX IF NOT EXISTS idx_files_owner_trashed_date   ON files (owner_id, is_trashed, created_at DESC)`,
            sql`CREATE INDEX IF NOT EXISTS idx_files_owner_trashed_name   ON files (owner_id, is_trashed, name)`,
            sql`CREATE INDEX IF NOT EXISTS idx_shares_owner    ON share_links (owner_id, created_at DESC)`,
            sql`CREATE INDEX IF NOT EXISTS idx_shares_resource ON share_links (resource_id)`,
        ]