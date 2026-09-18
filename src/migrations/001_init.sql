-- 临时海域禁入判定服务：版本化通告 + 判定快照
-- 设计要点：
--   * notices / notice_revocations 均为只追加（append-only），
--     通告内容一经发布不可更改，撤销通过新批次中的撤销行表达；
--   * 一次发布批次（notice_batches）是一个事务，快照要么看到整批，
--     要么完全看不到，杜绝并发更新造成的混合版本；
--   * decisions.decision_snapshot 冻结判定当时可见的通告集合及其状态，
--     服务重启后仍可按 decision_id 逐字节复现。

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notice_batches (
    id          BIGSERIAL PRIMARY KEY,
    batch_ref   TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notices (
    notice_id       TEXT PRIMARY KEY,
    issuer          TEXT NOT NULL,
    sequence        BIGINT NOT NULL,
    revision        INTEGER NOT NULL CHECK (revision >= 1),
    replaces        TEXT REFERENCES notices (notice_id),
    valid_from      TIMESTAMPTZ NOT NULL,
    valid_until     TIMESTAMPTZ NOT NULL CHECK (valid_until > valid_from),
    polygon         JSONB NOT NULL,
    batch_id        BIGINT NOT NULL REFERENCES notice_batches (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (issuer, sequence),
    CHECK (polygon -> 0 = polygon -> jsonb_array_length(polygon) - 1)
);

CREATE INDEX IF NOT EXISTS notices_issuer_seq_idx
    ON notices (issuer, sequence);
CREATE INDEX IF NOT EXISTS notices_replaces_idx
    ON notices (replaces);

-- 撤销只追加：被点名的通告自该批次起失效，不修改 notices 原行。
CREATE TABLE IF NOT EXISTS notice_revocations (
    notice_id   TEXT PRIMARY KEY REFERENCES notices (notice_id),
    batch_id    BIGINT NOT NULL UNIQUE REFERENCES notice_batches (id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decisions (
    decision_id        TEXT PRIMARY KEY,
    idempotency_key    TEXT NOT NULL UNIQUE,
    request_body       JSONB NOT NULL,
    request_hash       TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('clear', 'restricted', 'needs_review')),
    result             JSONB NOT NULL,
    -- 快照边界：当时已提交的最大批次号。
    snapshot_max_batch BIGINT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 判定时可见的每份通告一行，冻结其当时状态（active/revoked）。
CREATE TABLE IF NOT EXISTS decision_snapshot (
    decision_id       TEXT NOT NULL REFERENCES decisions (decision_id) ON DELETE CASCADE,
    notice_id         TEXT NOT NULL REFERENCES notices (notice_id),
    visible_status    TEXT NOT NULL CHECK (visible_status IN ('active', 'revoked')),
    PRIMARY KEY (decision_id, notice_id)
);
