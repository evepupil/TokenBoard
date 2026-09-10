# 设备身份与重连机制验收记录 - 2026-06-30, updated 2026-07-20

## 范围

本记录覆盖 PR #19 中与设备身份、重新连接、多 server client profile、device-link 恢复、Antigravity 三类来源适配相关的验收结论。

## 2026-07-11 复核补充

- pairing code 消费、设备或安装实例创建、upload token 创建和审计日志写入已合并为同一个 D1 batch；任一语句失败时整体回滚，不再依赖事务外的补偿恢复。
- device revoke 与 installation revoke 已分别合并为单个 D1 batch；审计写入失败时 token、installation 和 device 更新整体回滚。
- Antigravity CLI status line 锁增加目录 identity 校验、缺失或损坏 PID grace period、陈旧 lease 回收和旧版 Windows Node 兼容判断，避免替换锁被旧 owner 删除或 PID 复用导致永久阻塞。
- Antigravity CLI statusline 仅保留本地脱敏诊断日志和原 statusline 透传；collector 的上传计量只读取 SQLite history，不再为 statusline JSONL 持久化 cursor、upload ACK 或与 SQLite history 的去重状态。
- 日报 `topModels` 现在携带模型自身的 source 列表；纯 Codex/Claude 模型在 mixed-source 日报中保留有效费用，只有包含 Antigravity 的模型标注费用不可用。新历史保存该字段，旧历史缺字段时保守回退到 report-wide source split。
- 已补 SQLite 真实事务契约测试，覆盖凭据创建前进程崩溃、审计插入失败和撤销回滚；纯 Fake 测试不作为 D1 原子性通过证据。

## 2026-07-20 复核补充

- 新设备 pairing code 在读取后被并发消费时，D1 batch 通过有条件 `INSERT ... SELECT` 产生零行写入，service 稳定返回 `401 Invalid or expired pairing code`，不会把 `NULL user_id` constraint 映射为 HTTP 500。
- `0028_remove_development_seed.sql` 始终移除固定开发 pairing credential，但只有未认证的默认 seed user 才会删除 profile、usage 和关联状态；带 Better Auth account 的既有用户保持完整数据。
- `0029_drop_redundant_pairing_code_hash_index.sql` 只删除冗余 named index，`pairing_codes.code_hash` 的表级 UNIQUE constraint 仍保持 pairing code hash 唯一。
- 上述结果来自本地 SQLite 和 route/service 回归；目标 D1 migration、认证页面和旧 client ingest 的真实环境验证仍在发布 gate 中，不能由本地测试替代。

### 复杂度豁免

以下文件暂时超过全局 800 行强制治理阈值，本轮记录明确豁免：

- `apps/web/app/features/device/service.ts`：设备查询、凭据轮换、撤销和 pairing 流程共享同一组事务断言与错误语义。刚完成原子性修复后立即跨文件搬运会扩大事务回归面。解除条件：按 `queries`、`credentials`、`pairing` 三个领域模块拆分，并保持 `service.ts` 兼容导出。
- `apps/web/app/routes/settings/devices.tsx`：同一路由同时提供列表、详情 fragment 和表单响应，组件共享完整页面状态。解除条件：先稳定 details fragment 契约，再拆为 `device-list`、`device-details`、`device-actions` 三组组件。
- `apps/web/app/features/device/repository.ts`：当前 894 行，主要由 D1 参数化 SQL statement builder 构成；拆分收益低于导入和事务顺序漂移风险。解除条件：新增 repository 职责或文件继续增长时，将 reconnect 与 new-device statements 分离。

豁免不覆盖安全、事务原子性、外部输入校验、Schema 契约和测试要求。其余 300-500 行且职责内聚的文件不再仅为满足行数进行机械拆分。

主要交付项：

- `devices` 表示用户视角的逻辑设备。
- `device_installations` 表示同一逻辑设备下的安装实例。
- `upload_tokens` 绑定 `device_id` 和 `installation_id`，旧 token 保持兼容。
- pairing code 区分 `new_device` 和 `reconnect_device`。
- Web UI 支持重新连接旧设备、token 轮换、不同层级撤销和审计日志展示。
- client config 按 server origin 保存 profile，避免正式环境和私人环境 token 覆盖。
- `device-link.json` 只作为本机敏感恢复状态，恢复必须显式 opt-in。
- `device-link` claim 换取 reconnect pairing code 后保留到 code 被消费或过期，避免响应丢失后客户端被卡死；pair 成功消费 code 时再轮换新 claim。
- reconnect code 消费前重新确认目标设备和安装实例仍有效；已撤销设备或安装实例不能用 stale code 重新换取 token。
- TokenBoard skill、安装提示、setup、status、uninstall、rotate-token 脚本已适配。
- Antigravity CLI、Antigravity、Antigravity IDE 三类来源已接入采集和 Web 展示。

## 不变量

- 服务端不保存明文 upload token，也不提供查看历史 token 的能力。
- 不使用硬件指纹、MAC、磁盘序列号、IP、hostname 自动合并设备。
- `device-link.json` 不上传 usage，不打印 install claim，不进入公开 artifact。
- Antigravity collectors 只上传 token、model、timestamp、source、去重 hash 和 cost placeholder。
- Antigravity prompt、completion、本地路径、原始历史 blob、原始 conversation id、原始 response id 不进入上传 payload。
- Antigravity 费用不可用，`costUsd` 只能作为 `0` 占位，UI、日报、Webhook、公开 JSON / SVG 必须标注费用不可用。
- Antigravity CLI status line capture 保持显式 opt-in，不包含在默认 hook `--source all` 安装中。
- reconnect pairing code 生成不能先失效旧 claim 再写 pairing code；claim rotation 必须在 code 消费路径完成。
- settings 页面生成 reconnect code 前必须校验目标设备和安装实例仍处于 active 状态。

## 代码证据

- D1 migration:
  - `apps/web/db/migrations/0022_device_installations.sql`
  - `apps/web/db/migrations/0023_device_install_claim.sql`
  - `apps/web/db/migrations/0024_upload_token_active_successor.sql`
  - `apps/web/db/migrations/0025_antigravity_costs_unavailable.sql`
- Web / API:
  - `apps/web/app/features/device/service.ts`
  - `apps/web/app/features/device/repository.ts`
  - `apps/web/app/features/device/device-details-client.ts`
  - `apps/web/app/features/device/components/install-command-commands.ts`
  - `apps/web/app/routes/api/v1/device/pair.ts`
  - `apps/web/app/routes/api/v1/device/pairing-codes.ts`
  - `apps/web/app/routes/api/v1/device/reconnect-pairing-codes.ts`
  - `apps/web/app/routes/settings/devices.tsx`
  - `apps/web/app/routes/settings/devices/details.tsx`
  - `apps/web/app/routes/settings/install.tsx`
- Client / skill:
  - `skills/tokenboard/scripts/config.mjs`
  - `skills/tokenboard/scripts/setup.mjs`
  - `skills/tokenboard/scripts/setup-options.mjs`
  - `skills/tokenboard/scripts/device-link.mjs`
  - `skills/tokenboard/scripts/install-collector.mjs`
  - `skills/tokenboard/scripts/upgrade-utils.mjs`
  - `skills/tokenboard/scripts/upgrade.mjs`
  - `skills/tokenboard/scripts/rotate-token.mjs`
  - `skills/tokenboard/scripts/uninstall.mjs`
  - `skills/tokenboard/SKILL.md`
- Antigravity:
  - `packages/collector/src/providers/antigravity-cli.ts`
  - `packages/collector/src/providers/antigravity-gui.ts`
  - `packages/collector/src/providers/antigravity-history-db.ts`
  - `packages/collector/src/providers/antigravity-history-protobuf.ts`

## 验证命令

以下命令均在本分支本地执行通过：

```bash
pnpm --filter @tokenboard/web exec vitest run app/features/device app/routes/api/v1/device app/routes/settings/devices.post.test.tsx app/routes/settings/devices.test.tsx app/routes/settings/devices/details.test.tsx app/routes/settings/install.post.test.tsx
pnpm --filter @tokenboard/collector test -- src/providers/antigravity-cli.test.ts src/providers/antigravity-gui.test.ts src/providers/antigravity-gui-client.test.ts src/providers/antigravity-history-db.test.ts src/providers/antigravity-history-protobuf.test.ts src/cli-antigravity.test.ts
node --test skills/tokenboard/scripts/*.test.mjs
pnpm test
pnpm typecheck
pnpm build
git diff --check HEAD
```

结果摘要：

- Web device/API/settings 相关测试覆盖新设备 pairing、device-link reconnect、stale code 拒绝、安装命令生成、详情页和撤销路径。
- TokenBoard skill 脚本测试：248 个测试通过。
- Workspace 测试：`packages/usage-core` 7 个、`packages/collector` 256 个、`apps/web` 548 个测试通过，共 811 个。
- Workspace typecheck：全部通过。
- Web build：通过。
- `pnpm audit --audit-level low`：未发现已知漏洞。
- `git diff --check`：无 whitespace 错误。

已知 warning：

- Web 测试和构建中仍会出现 Node `DEP0205 module.register()` deprecation warning；当前不影响命令退出码，未在本 PR 中处理。

## 真实环境 gate

本记录证明代码、测试和构建已收敛，不等同于生产环境已发布。

合并前后仍应按实际发布流程验证：

- Cloudflare D1 migration 能在目标环境应用成功。
- Worker 部署后 `/api/v1/me`、pairing、ingest、summary、devices 页面可用。
- 本机和目标远程 client 可通过最新 skill 完成 setup / status / sync。
- device-link reconnect 在响应丢失重试、pairing code 过期、设备撤销、安装实例撤销场景下返回稳定错误，不产生新 token。
- macOS/Linux/Windows 生成安装命令在默认分支、显式分支、all-hex 分支名和 raw ref 场景下行为一致。
- 多 server profile 切换不会覆盖其它 server credential。
- 旧 client bearer upload token 仍可 ingest。
- Web UI 移动端和桌面端设备页、安装页、dashboard、日报、公开 SVG / JSON 展示不溢出。
