# opendb-dsh

基于 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 二次开发的 PostgreSQL 集群自动化管理平台，部署在 Kubernetes 上。

核心思路：**每个 pod 都是一棵完整的 dsh 树，pod 模板由 dsh profile 生成，跨 pod 只发生在 dsh 自己定义的 seam 上；所有 pod 只通过 PostgreSQL 会合。**

- 详细设计：[docs/2026-08-16-opendb-dsh-platform-design.md](docs/2026-08-16-opendb-dsh-platform-design.md)（v0.4，含 dsh rc.6 全部 195 个插件包的迁移清单、产品模型与 P0 计划）

## 状态

设计已定稿到 v0.4，P0 可行性验证进行中（Host 派发 + Runtime 接力）。
