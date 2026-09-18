import type { EffectiveNotice, NoticeRecord } from "./types.js";

export interface ChainIssue {
  rootId: string;
  code: "revision_gap" | "revision_order" | "dangling_replaces" | "revived_after_revoke";
  message: string;
}

interface Chain {
  rootId: string;
  revisions: NoticeRecord[]; // revision 升序
  issues: ChainIssue[];
}

/**
 * 按 replaces 指针把通告组织为版本链，root 为 replaces=null 的首发版本。
 * 结构问题（断链、跳号、撤销后复活）作为 issues 保留，交由判定层决定 needs_review。
 */
export function buildChains(notices: NoticeRecord[]): Chain[] {
  const byId = new Map(notices.map((n) => [n.noticeId, n]));
  const roots = notices.filter((n) => n.replaces === null);
  const chains: Chain[] = [];

  for (const root of roots) {
    const revisions: NoticeRecord[] = [root];
    const issues: ChainIssue[] = [];
    let current = root;
    const seen = new Set<string>([root.noticeId]);
    // 每个父版本至多一个子版本（发布接口保证；历史脏数据防御性处理）。
    while (true) {
      const children = notices.filter((n) => n.replaces === current.noticeId);
      if (children.length === 0) break;
      const child = children[0]!;
      if (children.length > 1) {
        issues.push({
          rootId: root.noticeId,
          code: "revision_gap",
          message: `版本 ${current.noticeId} 存在 ${children.length} 个后续更正，链分叉`,
        });
      }
      if (seen.has(child.noticeId)) break;
      revisions.push(child);
      seen.add(child.noticeId);
      current = child;
    }
    revisions.sort((a, b) => a.revision - b.revision);
    for (let i = 1; i < revisions.length; i++) {
      const prev = revisions[i - 1]!;
      const rev = revisions[i]!;
      if (rev.revision !== prev.revision + 1) {
        issues.push({
          rootId: root.noticeId,
          code: "revision_gap",
          message: `链 ${root.noticeId} 版本号 ${prev.revision}->${rev.revision} 不连续`,
        });
      }
      if (new Date(rev.validFrom).getTime() < new Date(prev.validFrom).getTime()) {
        issues.push({
          rootId: root.noticeId,
          code: "revision_order",
          message: `链 ${root.noticeId} 版本 ${rev.noticeId} 生效早于前版`,
        });
      }
      if (prev.status === "revoked") {
        issues.push({
          rootId: root.noticeId,
          code: "revived_after_revoke",
          message: `链 ${root.noticeId} 在撤销后又出现版本 ${rev.noticeId}`,
        });
      }
    }
    chains.push({ rootId: root.noticeId, revisions, issues });
  }

  // replaces 指向不存在通告的悬挂记录（正常发布流程会拒绝，快照中不应出现）。
  for (const n of notices) {
    if (n.replaces !== null && !byId.has(n.replaces)) {
      chains.push({
        rootId: n.noticeId,
        revisions: [n],
        issues: [
          {
            rootId: n.noticeId,
            code: "dangling_replaces",
            message: `通告 ${n.noticeId} 的 replaces ${n.replaces} 不存在`,
          },
        ],
      });
    }
  }
  return chains;
}

export interface ActiveInterval {
  notice: EffectiveNotice;
  /** 管控生效区间（epoch ms），左闭右开；撤销版本不产生此区间。 */
  startMs: number;
  endMs: number;
}

export interface ChainTimeline {
  rootId: string;
  issues: ChainIssue[];
  /** 查询窗口内该链所有版本（含撤销）的管辖覆盖区间，撤销版本以 status 标明。 */
  covered: Array<{ startMs: number; endMs: number; notice: EffectiveNotice }>;
  active: ActiveInterval[];
}

/**
 * 解析一条版本链在查询窗口 [windowStartMs, windowEndMs) 内的生效版本时间线。
 *
 * 规则（左闭右开）：
 * - revision k 自其 valid_from 起替代 revision k-1，前版管辖截止到后版 valid_from；
 * - 每版的管辖区间 = [valid_from, min(valid_until, 下一版 valid_from))；
 * - revoked 版本不产生管控区间，但其 valid_from 同样终止前版效力（撤销即时生效）；
 * - 更正缩短有效期造成的空档按无管制处理（确定性规则，不触发人工复核）。
 */
export function chainTimeline(
  chain: Chain,
  windowStartMs: number,
  windowEndMs: number,
): ChainTimeline {
  const active: ActiveInterval[] = [];
  const covered: ChainTimeline["covered"] = [];
  const revs = chain.revisions;

  for (let k = 0; k < revs.length; k++) {
    const notice = revs[k]!;
    const fromMs = new Date(notice.validFrom).getTime();
    const untilMs = new Date(notice.validUntil).getTime();
    const nextFromMs = k + 1 < revs.length ? new Date(revs[k + 1]!.validFrom).getTime() : Infinity;
    const startMs = Math.max(windowStartMs, fromMs);
    const endMs = Math.min(windowEndMs, untilMs, nextFromMs);
    const effective: EffectiveNotice = { ...notice, rootId: chain.rootId };
    if (endMs > startMs) covered.push({ startMs, endMs, notice: effective });
    if (notice.status === "active" && endMs > startMs) {
      active.push({ notice: effective, startMs, endMs });
    }
  }

  return { rootId: chain.rootId, issues: chain.issues, covered, active };
}

/** 时刻 t 生效的版本（用于依据展示）；取 valid_from <= t 的最高 revision。 */
export function effectiveAt(chain: Chain, tMs: number): EffectiveNotice | null {
  let picked: NoticeRecord | null = null;
  for (const rev of chain.revisions) {
    const fromMs = new Date(rev.validFrom).getTime();
    if (fromMs <= tMs) picked = rev;
  }
  if (!picked) return null;
  const untilMs = new Date(picked.validUntil).getTime();
  if (picked.status !== "active" || tMs >= untilMs) return null;
  return { ...picked, rootId: chain.rootId };
}
