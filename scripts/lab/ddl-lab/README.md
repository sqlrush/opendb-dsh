# ddl_lab —— 表结构变更追溯的专用测试 schema（og5）

user 2026-08-30：在 og5 里新建一个专门测试这个功能的 schema，里面有多张在多个版本发生过 DDL 变更的表。

五个版本按顺序执行（每步之间让平台字典立刻快照，这样每一步都成为一个独立的结构版本）：

| 版本 | 内容 | 覆盖的规则/交互 |
|---|---|---|
| v1 | 建 schema `ddl_lab`：`orders` `customers` `products` `audit_log` 四张表 + 主键 | 建 schema 批次（主干节点 add，分支从主干分出） |
| v2 | `orders` 加 `status` 列 + `orders_customer_idx`；`customers` 加 `email` | 列级 +，索引 +（挂到表子线） |
| v3 | `orders.amount` 改类型 numeric(12,2)→(18,2)；删 `orders_customer_idx`、建 `orders_status_idx`；建 `shipments` 表 | 列 ~，索引 −/+，中途新建的表（子线从中段开始） |
| v4 | `customers` 删 `email`；`products` 加 `price`；**DROP TABLE `audit_log`** | 列 −，破坏性变更 DDLR01（子线封口 ×） |
| v5 | `shipments` 加 `eta`；建视图 `order_summary`；`products.sku` 改长度 | 视图对象、再改一次（DDLR05 抖动看时间间隔） |

执行方式（mac 上）：`bash scripts/lab/ddl-lab-build.sh`（默认全部 5 步；`bash scripts/lab/ddl-lab-build.sh 3` 只跑到 v3）。
脚本用平台账号 `opendb_ro`（og5 上已是 SYSADMIN）执行 SQL，每步之后 POST 集群 collector 的 `/dict-snapshot?node=og5` 立即快照。
清理：`bash scripts/lab/ddl-lab-build.sh clean`（DROP SCHEMA ddl_lab CASCADE）。
