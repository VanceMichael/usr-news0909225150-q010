#!/bin/sh
# 容器内一条命令验收：纯逻辑单测 + PostgreSQL 集成测试 + fixtures 端到端 + 真实进程重启恢复。
set -eu

echo "== 1/4 纯领域单测（坐标精度/边界/版本链/跨午夜） =="
node --test dist/test/geometry.test.js

echo "== 2/4 PostgreSQL 集成测试（撤销更正/相切/并发/事务失败/重启恢复） =="
node --test dist/test/integration.test.js

echo "== 3/4 仓库 fixtures 端到端：更正替代原通告 =="
node scripts/fixture-smoke.mjs

echo "== 4/4 服务进程重启恢复（按判定 ID 复现冻结快照） =="
node scripts/restart-check.mjs

echo "全部验收通过"
