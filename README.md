# 临时海域禁入判定服务

航线判定依赖版本化通告、有效时段和海域边界。仓库提供虚构的多边形、航线与更正关系，并配置 PostgreSQL 作为开发数据库。

## 环境检查

```sh
docker compose up --build --abort-on-container-exit domain-check
```

坐标数据只用于软件开发，不可作为实际航行依据。数据库凭据仅供本地容器使用。
