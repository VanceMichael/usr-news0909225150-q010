# 临时海域禁入判定服务

航线判定依赖**版本化通告、有效时段和海域边界**。本服务是纯后端判定服务：值班员提交船舶航线计划，服务在一次一致性快照中返回可复核结论——在什么时间、哪一个航段、进入了哪一份生效通告所覆盖的区域，以及该结论使用的通告集合。

坐标数据只用于软件开发，不可作为实际航行依据。数据库凭据仅供本地容器使用。

## 判定结论

| 状态 | 含义 |
| --- | --- |
| `clear` | 按当前生效通告集合，航线不进入任何管制区 |
| `restricted` | 存在相交：返回首个相交航段、进入/离开时刻与坐标、生效依据通告 |
| `needs_review` | 航线与区域边界单点相切（擦边），不自动放行，交人工复核 |
| `stale` | 仅由复检（recheck）返回：历史判定所依据的通告集合此后发生了影响结论的变化 |

## 领域约定

- **坐标精度**：经纬度统一四舍五入到 **7 位小数**（约 1.1 厘米）；小于该尺度的差异视为同一点，避免浮点误差把相切误判成穿越。
- **多边形**：闭合环，首末点必须重合；**边界属于区域内部**——沿边界航行算 `restricted`，仅单点擦过顶点且两侧在区外算 `boundary_tangent`（`needs_review`）。
- **有效期**：半开区间 `[valid_from, valid_until)`，`valid_until` 时刻已离开区域；因此通告可天然跨午夜衔接（如 `23:00`–次日 `01:00`、`23:59:59` 与 `00:00:00`）。
- **航速与时刻**：全程恒定航速（节），里程按恒向线（rhumb line，地球半径 3440.065 NM）计算，航段内时刻线性插值。
- **版本关系**：同一签发机构（`issuer`）内按 `sequence` 建立版本链，`revision` 递增、`replaces` 指向前一版本。后续**未撤销**版本在其有效期内替代旧版本；相交时段跨越替代时刻时，区间在替代时刻被精确截断，`basis` 同时记录前后两版并在 `review_notes` 中注明接管关系。
- **撤销语义**：撤销只废止被点名的那一份通告（只追加一行，不改写原文）。撤销一份**更正**后，原通告在其自身有效期内恢复生效；撤销原件不影响已生效的更正件。

## 一条命令验收

```sh
docker compose up --build --abort-on-container-exit acceptance
```

验收服务对容器化 PostgreSQL 17 依次执行 6 个端到端场景并在结束时自动停机：

1. 跨午夜有效期（半开区间边界）
2. 撤销更正后原通告恢复生效
3. 边界相切 → `needs_review`
4. 判定与发布并发：快照要么不含新批次、要么含整批，**绝不出现混合版本**
5. 事务注入失败：整体回滚、不留结果，重试成功且重复提交只有一份
6. 服务进程被杀死重启后，仍可按判定 ID 复现原结论

## 启动服务

```sh
docker compose up --build api
# 服务监听 http://localhost:8080
# 可选：载入仓库 fixtures 中的示例通告
docker compose run --rm api npm run seed
```

### API

**提交判定**（幂等）`POST /decisions`

```json
{
  "decision_id": "D-01",
  "idempotency_key": "route-check-0001",
  "departure_at": "2026-09-06T05:30:00+08:00",
  "speed_knots": 12,
  "route": [[118.90, 39.10], [119.20, 39.10], [119.50, 39.10]]
}
```

- 首次提交返回 `201`；同一 `idempotency_key`（或 `decision_id`）重复提交返回 `200` 与**首次冻结的同一份结果**，绝不产生第二行。
- 同一 `idempotency_key` 携带不同请求内容返回 `409`。

响应（`restricted` 示例，节选）：

```json
{
  "decision_id": "D-01",
  "status": "restricted",
  "first_intersection": {
    "kind": "inside",
    "segment_index": 0,
    "enters_at": "2026-09-05T21:58:…Z",
    "exits_at":  "2026-09-05T22:00:00.000Z",
    "entry": {"segment_index": 0, "at": "…", "lon": 119.1, "lat": 39.1, "t": 0.333},
    "exit":  {"segment_index": 0, "at": "…", "lon": 119.4, "lat": 39.1, "t": 0.833}
  },
  "basis": [
    {"notice_id": "N-10", "issuer": "AUTH-T", "sequence": 10, "revision": 1, "replaces": null,
     "status": "active", "valid_from": "…", "valid_until": "…", "batch_id": 1},
    {"notice_id": "N-10-R2", "issuer": "AUTH-T", "sequence": 11, "revision": 2, "replaces": "N-10",
     "status": "active", "…": "…"}
  ],
  "review_notes": ["通告 N-10 于 … 被同机构 N-10-R2(rev 2) 替代，相交区域由后者接管"],
  "snapshot": {
    "batch_refs": ["B-v1", "B-v2"],
    "notice_versions": [{"notice_id": "N-10", "issuer": "AUTH-T", "sequence": 10, "revision": 1, "status": "active"}]
  }
}
```

其余端点：

| 方法/路径 | 说明 |
| --- | --- |
| `GET /decisions/:id` | 取回冻结结论（服务/数据库重启后仍可复现） |
| `POST /decisions/:id/recheck` | 用当前通告集合对冻结请求复检；依据漂移时返回 `stale` 与差异，历史行不改写 |
| `POST /admin/batches` | 原子发布一个批次：`{batch_ref, ops:[{op:"publish",notice:{…}} | {op:"revoke",notice_id}]}`，整批成功或整批不生效 |
| `GET /healthz` | 健康检查 |

## 一致性快照与复现是怎么保证的

1. 通告与撤销均为**只追加**数据；一个发布批次的全部写入在同一事务提交，其他事务只能看到整批或完全看不到。
2. 发布与判定在各自事务内先竞争同一把事务级咨询锁（`pg_advisory_xact_lock`），两类操作在全局完全有序：判定进行期间不可能穿插提交新批次。
3. 判定结果与 `decision_snapshot`（判定时可见的每份通告及其 `active/revoked` 状态）在**同一事务**写入；任何中途失败整体回滚（可用 `POST /decisions?fault=abort_after_snapshot` 演练）。
4. 判定引擎是纯函数，重启后既可直接取回冻结结果，也可用冻结快照**重放引擎**逐字节复现；此后再发布通告不影响历史结论，复检差异通过 recheck 显式报告。

## 本地开发（无 Docker 时）

集成测试使用 `embedded-postgres`（自动下载用户态 PostgreSQL 17 二进制，无需系统安装）：

```sh
npm ci
npm test          # node:test 集成测试，22 个用例
npm run build     # 类型检查 + 编译到 dist/
npm run dev       # 直接以 tsx 启动（需自行提供 DATABASE_URL）
```

## 目录

```
contracts/   请求 JSON Schema（航线点形状约束在服务端补全）
fixtures/    示例通告与航线（虚构数据）
scaffold/    领域文件自检：npm run domain:check
src/         精度/几何/航行推算、判定引擎、数据库事务、HTTP 服务
test/        node:test 集成测试与 compose 验收脚本
```
