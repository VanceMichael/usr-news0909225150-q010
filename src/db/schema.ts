/**
 * 数据库结构。
 *
 * notices：通告版本不可变（append-only）。publish_order 为全局发布全序（bigserial），
 * (issuer, sequence) 唯一约束防止同一机构序列并发重复发布；replaces 自引用构成版本链。
 *
 * decisions：判定结论与冻结的请求/结果（结果 JSON 内嵌当时通告全量副本）。
 * decision_snapshot_notices：判定-通告快照关联（同事务复制，用于审计查询）。
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "001_init",
    sql: `
create table if not exists notices (
  notice_id      text primary key,
  issuer         text not null,
  sequence       bigint not null,
  revision       integer not null,
  replaces       text references notices(notice_id),
  valid_from     timestamptz not null,
  valid_until    timestamptz not null,
  polygon        jsonb not null,
  status         text not null check (status in ('active', 'revoked')),
  published_at   timestamptz not null default now(),
  publish_order  bigserial not null,
  constraint notices_time_order check (valid_until > valid_from),
  constraint notices_revision_positive check (revision >= 1)
);
create unique index if not exists notices_issuer_sequence_uq
  on notices (issuer, sequence);
create index if not exists notices_replaces_idx on notices (replaces);

create table if not exists decisions (
  decision_id                    text primary key,
  idempotency_key                text not null unique,
  status                         text not null check (status in ('clear','restricted','needs_review','stale')),
  request_hash                   text not null,
  request_json                   jsonb not null,
  result_json                    jsonb not null,
  snapshot_max_publish_order     bigint,
  reassessment_json              jsonb,
  created_at                     timestamptz not null default now()
);

create table if not exists decision_snapshot_notices (
  decision_id   text not null references decisions(decision_id) on delete cascade,
  notice_id     text not null,
  publish_order bigint not null,
  primary key (decision_id, notice_id)
);

-- 仅供验收测试做确定性并发交错（门闩），业务路径不使用。
create table if not exists test_gates (
  gate_id   text primary key,
  arrivals  integer not null default 0,
  released  boolean not null default false,
  fail      boolean not null default false
);
`,
  },
];
