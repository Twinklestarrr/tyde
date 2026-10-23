# Agent 数据迁移

本目录预留 Agent 自有 PostgreSQL 迁移，与 `apps/server/prisma` 的业务迁移分开。

W1 尚未引入数据库驱动、DDL 或迁移执行器，也未配置连接信息；根目录 `db:*` 命令不会执行本目录。正式接库前确定 Kysely＋pg 适配、数据库／schema 与账号隔离、专用测试库及版本控制，再增加独立迁移命令。
