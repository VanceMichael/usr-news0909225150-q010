# 临时海域禁入判定服务（纯后端）

船舶计划在多个临时管制区之间穿行时，值班员在放行前需要一个**可复核**结论：航线在什么时刻进入哪一片
有效区域、后来发布的更正/撤销是否替代原通告、以及结论是否因通告并发更新而使用了混合版本。

本服务只提供 JSON API 与判定能力，**不含任何地图或前端**。技术栈：Node.js 22 + TypeScript（ESM）+
PostgreSQL 17。坐标数据仅用于软件开发，不可作为实际航行依据。

## 一条命令启动 / 验收

```sh
# 启动 API（:8080）与 PostgreSQL
docker compose up --build api postgres

# 一条命令完成全部验收（单测 + 集成测试 + fixtures 端到端 + 真实进程重启恢复）
docker compose up --build --abort-on-container-exit acceptance
```

无 Docker 的本机环境可用 `npx tsc -p tsconfig.json && node scripts/acceptance-local.mjs`
（通过 `embedded-postgres` 免 root 拉起临时数据库，仅用于本地开发）。

## 领域约定

- **坐标**：WGS-84 / EPSG:4326，`[经度, 纬度]` 十进制度；输入统一量化到 **7 位小数**
  （`src/domain/constants.ts` 的 `COORD_DECIMALS`），所有几何比较在量化网格上以 `1e-7` 容差进行。
- **距离/时间**：haversine 大圆距离（地球半径 6371km，1 海里 = 1852m），航速以节计；
  航段按恒定航速展开为时间线。
- **边界规则**：
  - 穿越边界（交点两侧在多边形外）或位于区域内部 → `interior`（侵入）；
  - 仅在非进入意义上接触——顶点触碰（含航段端点落在边界）或沿边滑行 → `boundary`，判 **needs_review**，
    不直接放行也不直接禁入，交由值班员复核；
  - 无接触 → 不产生记录。
- **有效期**：全部时间区间左闭右开 `[valid_from, valid_until)`，跨午夜按真实时刻判定（UTC 存储）。
- **版本关系**：通告按 `issuer`（签发机构）+ `sequence`（机构内单调序列）与 `revision` 建版本链，
  `replaces` 指向前一版本：
  - revision k 自其 `valid_from` 起**替代** revision k−1，前版管辖截止到后版 `valid_from`；
  - 更正缩短有效期造成的空档按无管制处理；
  - `status:"revoked"` 的撤销版不产生管控区间，但其 `valid_from` 同样终止前版效力；
  - 发布为 append-only：revision 必须接续、同一机构、已撤销链不得再更正；重复 `(issuer, sequence)` 拒绝。

## 判定结论

| status | 含义 |
| --- | --- |
| `clear` | 航程时间窗内无任何有效侵入 |
| `restricted` | 存在穿越/内部航段，返回**首个相交航段**（航段序号、进入/离开时刻、交点、依据通告） |
| `needs_review` | 边界相切或版本链异常等不能自动放行的情形，附 `review_reasons` |
| `stale` | 历史判定读取时发现依据通告已被后续发布改变，附 `reassessment`（原冻结结论 + 当前复算结论） |

首个相交按（进入时刻, 航段序号, 沿航段比例）排序；`effective_notices` 给出航程窗口内具有管辖权的版本，
撤销版本保留且 `status=revoked`，使“后来的更正是否替代原通告”一目了然。

## 一致性快照与并发安全

- `notices` 表 append-only，`publish_order bigserial` 为全局发布全序。
- 发布与判定都先取同一把 **PostgreSQL 会话级咨询锁**，再开启 `REPEATABLE READ` 事务：
  快照必定建立在“无并发发布”的时刻，读到的通告集合必然是发布全序的某个**前缀**，
  因此一次判定绝不会使用横跨两次发布的混合版本。集成测试用测试门闩（test gate）确定性地制造
  “判定进行中并发发布”的交错来验证这一点。
- **幂等**：`decision_id` 与 `idempotency_key` 均有唯一约束并在锁内查重；重复提交（含并发双提交）
  只返回既有那一份结果，不产生第二条记录；键复用于不同请求返回 409。
- **事务失败**：任何错误整体回滚，决策行、快照关联、通告均不留半成品。
- **重启复现**：判定结果行内**完整冻结当时通告集合**（`result_json.snapshot_notices`），
  并在 `decision_snapshot_notices` 留有审计索引。服务重启后仅凭判定 ID 即可取回原结论，
  也可用冻结快照纯函数重放出完全相同的结果。
- 读取历史判定时若发现新发布：用当前通告全量重算；结论/首个相交/生效依据集合任一变化则置 `stale`，
  原始冻结结果仍原样保留可审计；无关海域的新发布不会使结论变 stale。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/admin/notices` | 发布/更正/撤销一份通告（append-only） |
| POST | `/v1/decisions` | 提交航线判定（幂等） |
| GET | `/v1/decisions/:id` | 取回判定，含 `basis_current` 与可能的 `reassessment` |
| GET | `/healthz` | 存活探针 |

请求体遵循 `contracts/route-check.schema.json`：

```json
{
  "decision_id": "D-01",
  "idempotency_key": "route-check-0001",
  "departure_at": "2026-09-06T05:30:00+08:00",
  "speed_knots": 12,
  "route": [[118.90, 39.10], [119.20, 39.10], [119.50, 39.10]]
}
```

通告示例见 `fixtures/notices.json`（原通告 N-10 与更正 N-10-R2）。`scripts/fixture-smoke.mjs`
验证：船 05:30 出发，06:00 后原通告被更小范围的更正版替代，船实际进入时的生效依据为 **N-10-R2**。

## 目录结构

```
src/domain/   纯领域逻辑：常量约定、几何、时间线、版本链、判定引擎、校验
src/db/       连接、迁移/schema、通告与判定仓储
src/service/  事务编排：咨询锁、幂等、快照、stale 复算、测试门闩
src/http/     JSON API 与 snake_case 展示层（无静态资源）
test/         node:test 单元测试与 PostgreSQL 集成测试
scripts/      验收脚本（容器 acceptance.sh；本机 embedded-postgres wrapper）
contracts/    请求 JSON Schema；fixtures/ 虚构通告与航线；scaffold/ 原有领域校验
```

## 测试覆盖

- 单元（纯逻辑）：坐标量化、haversine、穿越/顶点相切/沿边/端点落界/无关、版本链接替与撤销、跨午夜判定。
- 集成（PostgreSQL）：跨午夜有效期、撤销更正（旧判定 stale、新判定 clear 且依据标明 revoked）、
  边界相切、幂等与并发双提交、键冲突 409、并发发布不混入快照（门闩确定性交错）、
  并发重复发布同序列、事务失败回滚、非法更正拒绝、重启后按 ID 复现冻结集合。

数据库凭据仅用于本地容器/开发。
