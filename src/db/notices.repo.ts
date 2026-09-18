import type { PoolClient } from "pg";
import type { NoticeRecord } from "../domain/types.js";

interface NoticeRow {
  notice_id: string;
  issuer: string;
  sequence: string;
  revision: number;
  replaces: string | null;
  valid_from: Date;
  valid_until: Date;
  polygon: unknown;
  status: "active" | "revoked";
  published_at: Date;
  publish_order: string;
}

export function mapNoticeRow(row: NoticeRow): NoticeRecord {
  return {
    noticeId: row.notice_id,
    issuer: row.issuer,
    sequence: Number(row.sequence),
    revision: row.revision,
    replaces: row.replaces,
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until.toISOString(),
    polygon: row.polygon as NoticeRecord["polygon"],
    status: row.status,
    publishedAt: row.published_at.toISOString(),
    publishOrder: Number(row.publish_order),
  };
}

export interface NewNotice {
  noticeId: string;
  issuer: string;
  sequence: number;
  revision: number;
  replaces: string | null;
  validFrom: string;
  validUntil: string;
  polygon: [number, number][];
  status: "active" | "revoked";
}

/** append-only 发布。(issuer, sequence) / notice_id 冲突抛 23505 由上层处理。 */
export async function insertNotice(client: PoolClient, input: NewNotice): Promise<NoticeRecord> {
  const { rows } = await client.query<NoticeRow>(
    `insert into notices
       (notice_id, issuer, sequence, revision, replaces, valid_from, valid_until, polygon, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     returning *`,
    [
      input.noticeId,
      input.issuer,
      input.sequence,
      input.revision,
      input.replaces,
      input.validFrom,
      input.validUntil,
      JSON.stringify(input.polygon),
      input.status,
    ],
  );
  return mapNoticeRow(rows[0]!);
}

export async function getNoticeById(
  client: PoolClient,
  noticeId: string,
): Promise<NoticeRecord | null> {
  const { rows } = await client.query<NoticeRow>(
    "select * from notices where notice_id = $1",
    [noticeId],
  );
  return rows[0] ? mapNoticeRow(rows[0]) : null;
}

/** 一致性快照读取：publish_order <= highWater 的全部通告，按发布全序返回。 */
export async function getSnapshotNotices(
  client: PoolClient,
  highWater: number,
): Promise<NoticeRecord[]> {
  const { rows } = await client.query<NoticeRow>(
    "select * from notices where publish_order <= $1 order by publish_order",
    [highWater],
  );
  return rows.map(mapNoticeRow);
}

export async function getAllNotices(client: PoolClient): Promise<NoticeRecord[]> {
  const { rows } = await client.query<NoticeRow>(
    "select * from notices order by publish_order",
  );
  return rows.map(mapNoticeRow);
}

export async function getMaxPublishOrder(client: PoolClient): Promise<number | null> {
  const { rows } = await client.query<{ max: string | null }>(
    "select max(publish_order)::text as max from notices",
  );
  return rows[0]!.max === null ? null : Number(rows[0]!.max);
}
