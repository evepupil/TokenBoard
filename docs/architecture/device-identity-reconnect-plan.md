# TokenBoard 设备身份与重新连接方案

状态：已实现，后续增强持续维护
日期：2026-06-29

## 背景

TokenBoard client 通过 upload token 向 TokenBoard server 上传 AI token 用量快照。upload token 是认证凭证，不是设备身份。它只在配对时展示一次，服务端只保存 hash。

本次 Antigravity 支持和私人 Cloudflare 环境验证暴露了一个产品缺口：client 在私人环境和正式环境之间切换时，当前单一 `config.json` 容易被覆盖。一旦旧 server 的 upload token 不再保存在本机，Web UI 也无法恢复它，因为服务端从不保存明文 token。正确恢复方式应是重新配对、重置 token 或重新连接旧设备，而不是查看历史 token。

本文记录设备身份、重新连接和多 server profile 的已落地设计，同时保留未实现的后续增强边界：

- 支持卸载、重装、换系统、切换 server 后重新连接旧逻辑设备；
- 支持 Windows、Linux、macOS、黑苹果、WSL、虚拟机、系统重装等跨平台场景；
- server 升级后保持老 client 兼容；
- 避免硬件指纹、hostname、IP 等不安全的自动合并；
- 明确 token、设备、安装实例之间的边界。

## 目标

- 用户明确确认后，新 client 安装可以挂回旧逻辑设备，保持设备历史连续。
- 一个 client 可以保存多个 TokenBoard server 的凭证，避免切换环境时覆盖旧 token。
- server schema 升级后，旧 client 仍可继续上传。
- 高危 token 操作可审计、可追踪。
- 不上传、不保存 prompt、completion、本地路径、原始历史 blob 或硬件标识。

## 非目标

- 不提供查看历史 upload token 明文的能力。
- 不用硬件指纹、MAC 地址、磁盘序列号、IP、hostname 自动识别物理设备。
- 当系统全新重装且本地 TokenBoard 状态完全丢失时，不自动合并到旧设备。
- 不把 GitHub OAuth 重新登录当成强 MFA 或 GitHub sudo mode。它最多只能作为弱账号连续性确认。

## 当前实现

当前分支已落地的主要实现位置：

- D1 schema 与 migration：`apps/web/app/db/schema-identity.ts`、`apps/web/db/migrations/0022_device_installations.sql` 至 `0027_daily_report_model_sources.sql`。
- 设备与凭据服务：`apps/web/app/features/device/service.ts`、`apps/web/app/features/device/repository.ts`。
- client profile 与 device-link：`skills/tokenboard/scripts/config.mjs`、`skills/tokenboard/scripts/device-link.mjs`、`skills/tokenboard/scripts/setup.mjs`、`skills/tokenboard/scripts/rotate-token.mjs`。
- 设备页与安装页：`apps/web/app/routes/settings/devices.tsx`、`apps/web/app/routes/settings/install.tsx`。

pairing、reconnect、token rotate/revoke、installation/device revoke 均已接入审计日志和事务测试。当前仍未实现的增强只有 WebAuthn/TOTP step-up 和手动合并设备。

## 当前模型

当前相关表：

- `devices(id, user_id, name, platform, last_synced_at, created_at, updated_at)`
- `device_installations(id, user_id, device_id, platform, install_claim_hash, revoked_at, ...)`
- `upload_tokens(id, user_id, name, token_hash, device_id, installation_id, supersedes_token_id, ...)`
- `pairing_codes(id, user_id, code_hash, pairing_type, target_device_id, expires_at, consumed_at, ...)`
- `audit_logs(id, user_id, action, target_type, target_id, metadata, created_at)`
- `daily_usage` 主键包含 `user_id, device_id, source, usage_date, model`

旧版 client config 只有单 server 凭证：

```json
{
  "endpoint": "https://tokenboard.example.com/api/v1/ingest",
  "uploadToken": "tb_upload_...",
  "deviceId": "dev_...",
  "timezone": "Asia/Shanghai"
}
```

这个结构不足以安全支持正式环境、私人环境、测试环境之间的来回切换。当前 client 已通过下方的
`servers` profile 结构兼容多个 server，并继续镜像 active profile 到这些旧字段。

## 设备身份模型

采用三层身份：逻辑设备、安装实例、上传凭证。

### 1. 逻辑设备

`devices` 表示用户在 Web UI 中看到并确认的“这台设备”。它不等同于某一次 OS 安装。

示例：

- `<device>`
- `GZ016518DC`
- `Ubuntu server`

该记录代表用户视角里的设备身份。后续可按需增加 `active`、`current_platform`、`display_name` 等字段。

### 2. 安装实例

新增 `device_installations` 表，表示某个 OS/runtime 上的一次 TokenBoard client 安装。

同一个逻辑设备下面可以有多个安装实例：

- Windows 安装实例；
- 换 Linux 后的新安装实例；
- 迁移到 macOS 或黑苹果后的新安装实例。

迁移后的表结构：

```sql
CREATE TABLE device_installations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  hostname TEXT,
  client_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX device_installations_user_id_idx
  ON device_installations(user_id);

CREATE INDEX device_installations_device_id_idx
  ON device_installations(device_id);
```

`installation_id` 应由服务端在配对成功时生成。client 只保存这个 id，不自行决定身份。

### 3. 上传凭证

`upload_tokens` 仍然只负责认证。新增 `installation_id`，但要保持旧 client 兼容：

```sql
ALTER TABLE upload_tokens ADD COLUMN installation_id TEXT;
ALTER TABLE upload_tokens ADD COLUMN supersedes_token_id TEXT;
```

upload token 仍然只展示一次，服务端仍然只保存 `token_hash`。

## Client 多 server 配置

当前 client 使用多 server profile，同时保留旧字段，便于旧脚本、回滚和兼容。

```json
{
  "activeServer": "https://tokenboard.chaosyn.com",
  "servers": {
    "https://tokenboard.chaosyn.com": {
      "endpoint": "https://tokenboard.chaosyn.com/api/v1/ingest",
      "deviceId": "dev_prod",
      "installationId": "inst_prod",
      "uploadToken": "tb_upload_prod",
      "timezone": "Asia/Shanghai"
    },
    "https://tokenboard.example.com": {
      "endpoint": "https://tokenboard.example.com/api/v1/ingest",
      "deviceId": "dev_selfhosted",
      "installationId": "inst_selfhosted",
      "uploadToken": "tb_upload_selfhosted",
      "timezone": "Asia/Shanghai"
    }
  },
  "endpoint": "https://tokenboard.chaosyn.com/api/v1/ingest",
  "deviceId": "dev_prod",
  "installationId": "inst_prod",
  "uploadToken": "tb_upload_prod",
  "timezone": "Asia/Shanghai"
}
```

规则：

- 新 client 优先读取 `activeServer` 和 `servers`。
- 旧字段仍然镜像当前 active server profile。
- 切换 server 时更新 `activeServer`，并同步旧字段。
- 如果本地已有目标 server profile，切回时不需要重新配对。
- 如果本地没有目标 server profile，必须走该 server 的配对流程。

## device-link.json

client 会额外保留一个恢复状态文件：

```txt
~/.tokenboard/device-link.json
```

这个文件必须视为本机敏感状态文件，不能称为“非敏感 marker”。它本身不能上传 usage，但可能帮助恢复设备身份。

建议结构：

```json
{
  "version": 1,
  "serverOrigin": "https://tokenboard.chaosyn.com",
  "deviceId": "dev_...",
  "installationId": "inst_...",
  "installClaim": "random_secret..."
}
```

规则：

- 支持的平台上文件权限应为 `0600`。
- 服务端只保存 `installClaim` 的 hash。
- claim 必须绑定 `serverOrigin`、`user_id`、`device_id`。
- `uninstall` 默认保留该文件。
- `uninstall --all` 删除该文件。
- token 轮换或设备重连时，应同步轮换 claim，或显式使旧 claim hash 失效。当前 Web token 轮换会为绑定了 installation 的 token 生成新的 install claim，并给出 macOS/Linux/Git Bash 与 Windows PowerShell 两套 `rotate-token.mjs` 命令，用于在对应 client 上同时更新当前 server profile 的 upload token 和本机 `device-link.json`；legacy token 没有 installation 时只轮换 upload token。
- 当前实现只写入和展示存在性，不会用它静默换取新 token。

## 配对类型

扩展 pairing code，使它能区分普通新设备配对和旧设备重连。

```sql
ALTER TABLE pairing_codes ADD COLUMN pairing_type TEXT NOT NULL DEFAULT 'new_device';
ALTER TABLE pairing_codes ADD COLUMN target_device_id TEXT;
ALTER TABLE pairing_codes ADD COLUMN metadata TEXT;
```

类型：

- `new_device`：创建新的逻辑设备和安装实例。
- `reconnect_device`：把新的安装实例和 token 挂到当前用户已有的旧逻辑设备下。

现有 `code_hash` 唯一约束可以保留，但生成 pairing code 时应在极低概率冲突下重试。查询可用 code 时继续检查：

- `consumed_at IS NULL`
- `expires_at > now`
- code hash 匹配

消费 pairing code 时继续保留当前乐观锁：

```sql
UPDATE pairing_codes
SET consumed_at = ?
WHERE id = ?
  AND consumed_at IS NULL
```

## 重新连接流程

### 普通新安装

1. 用户从 Web UI 生成普通 pairing code。
2. client 针对目标 server 执行 setup。
3. 服务端创建：
   - `device`
   - `device_installation`
   - `upload_token`
4. client 保存对应 server profile，并镜像旧 config 字段。

### 切回某个 server

1. client 检查 `servers[origin]` 是否存在。
2. 如果存在，切换 active profile 并上传。
3. 如果不存在，必须针对该 server 重新配对。

### config 删除但 device-link 保留

`device-link.json` 只能作为恢复信号，不应在没有用户意图的情况下静默换取新 token。

推荐流程：

1. setup 检测到 `device-link.json`。
2. setup 带上 claim 参与 pairing，或提示用户确认恢复。
3. 服务端校验 claim hash 和设备归属。
4. 服务端先使旧 claim hash 失效，再生成绑定旧 device 的 reconnect pairing code。
5. client 消费 pairing code 后，服务端在旧 device 下创建新的 installation/token。

### 系统全新重装且本地状态全丢

不能安全自动识别。

必须走 Web UI：

1. 用户登录 TokenBoard。
2. 打开旧设备详情。
3. 点击“重新连接此设备”。
4. 服务端生成绑定该 `device_id` 的 `reconnect_device` pairing code。
5. 新系统上的 client setup 消费该 pairing code。
6. 服务端在旧 device 下创建新的 installation/token。

### 系统类型变化

Windows 换 Linux、Linux 换 macOS/黑苹果、WSL 换原生 Linux、虚拟机换宿主机等场景，不应仅因 platform 变化就新建逻辑设备。

当用户选择“重新连接此设备”时：

- 保持旧 `device_id`；
- 创建新的 `installation_id`；
- 在 installation 上记录 platform、hostname、client version；
- 可记录 `device.platform_migration` 审计事件。

hostname、platform、IP、User-Agent、OS 只能作为提示信息，不能作为自动合并依据。

## Token 轮换和吊销

需要区分作用域：

- `token.revoke`：停用单个 upload token。
- `installation.revoke`：停用某个 installation 下的 active token。
- `device.revoke`：停用整个逻辑设备下的 active token/installation。
- `device.reconnect`：在旧 device 下创建新的 installation/token。

重新连接旧设备时，不应误停用同一逻辑设备下的其他 installation。

如果需要灰度期，应显式建模：

- `upload_tokens.supersedes_token_id`
- 旧 token 在 `grace_expires_at` 前仍有效
- ingest 依赖 snapshot 幂等和现有 daily upsert key 避免重复计数

第一版建议默认立即吊销旧 token，复杂度更低。

## Ingest 兼容性

server 升级后，旧 client 必须继续可用。

规则：

- ingest payload 不要求必须带 `installationId`。
- `Authorization: Bearer <uploadToken>` 保持不变。
- 如果 token 已绑定 `installation_id`，服务端使用它。
- 如果 token 没有 `installation_id`，服务端映射到 legacy installation。
- 如果 token 也没有 `device_id`，保留旧逻辑并标记为 legacy。
- 不改变 `daily_usage` 现有幂等语义。

建议 migration 顺序：

1. 新增 `device_installations`。
2. 为每个现有 device 创建一个 legacy installation。
3. 为已有 `upload_tokens` 回填 `installation_id`。
4. 在确认兼容路径稳定前，保持 `upload_tokens.installation_id` 可为空。

## 统计连续性

历史 usage 以 `device_id` 归属。用户通过“重新连接此设备”挂回旧 device 后，设备级历史自然连续。

如果用户无法重连旧设备，只能创建新 device，则用户级总量仍应正确，因为 dashboard、public card、webhook、leaderboard、report 默认应按 `user_id` 聚合，而不是按单个 device 聚合。

要求：

- 用户总览类查询默认按 `user_id` 聚合。
- 只有设备详情页才按 `device_id` 或 `installation_id` 展示。
- 未来可增加“手动合并设备”，但必须显式确认并写审计日志。

## 审计日志

在 Web UI 暴露重新连接或 token 轮换前，应先落地审计日志。

建议表：

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX audit_logs_user_created_idx
  ON audit_logs(user_id, created_at);

CREATE INDEX audit_logs_target_idx
  ON audit_logs(target_type, target_id);
```

至少记录：

- `device.pair`
- `device.reconnect`
- `device.rename`
- `device.revoke`
- `installation.revoke`
- `token.rotate`
- `token.revoke`

## Step-up 验证

Web UI 不允许查看历史 token。高危操作可以要求 step-up 验证。

短期：

- GitHub OAuth 重新确认只能证明当前浏览器还能完成同一 GitHub 账号的 OAuth 流程。
- 它不是 GitHub sudo mode，也不是强 MFA。

中期：

- WebAuthn/passkey 或 TOTP 更适合作为强 step-up。

建议要求 step-up 的操作：

- 重新连接旧设备；
- 轮换或停用 token；
- 停用 installation 或 device；
- 生成绑定旧 device 的 pairing code。

## UI 要求

设备页：

- 不提供“查看 token”。
- 提供“重新连接此设备”。
- 提供“停用此安装”和“停用整个设备”，并明确作用域。
- 在逻辑设备下展示安装历史。
- 生成 reconnect pairing code 时，明确说明新 client 会绑定到当前选中的旧设备。

安装页：

- 说明 upload token 只展示一次。
- 说明切换 server 时会优先使用本地 server profile。
- 保留生成命令里的 `--repo-url` 和 `--repo-ref`。

## 兼容和上线顺序

推荐顺序：

1. server migration：新增 nullable `installation_id` 和 legacy backfill。
2. ingest 兼容路径：旧 client 不带 `installationId` 仍能上传。
3. 审计日志表和服务层 helper。
4. Web UI reconnect 流程和 pairing type。
5. 新 client config 读写：支持多 server profile，并镜像旧字段。
6. 可选：device-link 恢复。
7. 可选：WebAuthn/TOTP step-up 强化。

不要让 server migration 依赖所有 client 立即升级。

当前分支已落地：

- server migration、Drizzle schema、legacy installation backfill；
- pairing code 的 `new_device` / `reconnect_device` 区分；
- 新设备配对创建 `device + device_installation + upload_token`；
- 旧设备重连创建新的 `device_installation + upload_token`，不新建逻辑设备；
- upload token 认证返回 nullable `installationId`，旧 token 仍可上传；
- ingest 成功后更新 device 与 installation 的同步时间；
- Web 设备页提供“重新连接”入口，并复用安装页生成绑定旧设备的 pairing code；
- Web 设备页在逻辑设备下展示安装实例、最近操作，并支持停用单个 installation；
- Web 设备页展示单个 upload token 元信息，并支持 token 级停用；
- Web 设备页支持 upload token 轮换，旧 token 立即停用，新 token 只显示一次，并保留原 device/installation 归属；
- Web 安装页提供显式 `device-link.json` 恢复命令，不进入默认安装命令，也不展示 claim；
- reconnect、device revoke、installation revoke、token rotate、token revoke 已接入统一 step-up gate 预留点；默认关闭，不改变现有行为；
- client `config.json` 支持多 server profile，并镜像 active profile 到旧字段；
- client 写入 `device-link.json`，服务端只保存 `installClaim` hash，status 只展示文件存在性；
- client 提供 `rotate-token.mjs` 用于 Web token 轮换后的本机落盘，只更新匹配的 server profile，不覆盖其它 server 凭证；
- client setup 支持显式 `--use-device-link`，通过 install claim 换取绑定旧 device 的 reconnect pairing code；
- uninstall 默认保留 `device-link.json`，`--all` 或 `--remove-config-dir` 删除该敏感恢复状态；
- 已提供 token / installation / device 三种撤销作用域 helper，Web UI 暴露 installation 与 device 级停用；
- `device.pair`、`device.reconnect`、`device.rename`、`device.revoke`、`installation.revoke`、`token.rotate`、`token.revoke` 会写入审计日志；
- TokenBoard skill 与安装提示词已说明多 server profile 和 Antigravity hook opt-in 边界。

仍保留为后续阶段：

- WebAuthn / TOTP 等真实 step-up 验证器；
- 手动合并设备。

## 风险和缓解

### 风险：误合并两台机器

缓解：禁止基于 hostname、platform、IP 自动合并。只有用户从 Web UI 明确选择旧设备时才重连。

### 风险：测试私人 server 时覆盖正式 server token

缓解：多 server profile。切换 server 不覆盖其他 origin 的凭证。

### 风险：把 device-link 当成普通 marker

缓解：把它定义为本机敏感恢复状态文件，使用 `0600` 权限，claim 绑定 server/user/device，并在 token 轮换或重连时轮换或失效。

### 风险：server 部署后旧 client 失败

缓解：`installation_id` 保持 nullable，Bearer upload token 认证不变，为已有设备创建 legacy installation。

### 风险：Web session 被盗后生成 reconnect token

缓解：第一版至少记录审计日志；后续对 reconnect 和 token rotation 增加 step-up 验证。

## 后续增强

- 增加 WebAuthn/TOTP 等真实 step-up 验证器。
- 增加带审计和显式确认的手动设备合并。

## 决策摘要

采用保守的设备重连设计：

- 逻辑设备身份由用户确认；
- 安装实例记录 OS/client 安装变化；
- upload token 仍然是一性展示的认证凭证；
- 多 server profile 防止本地凭证互相覆盖；
- 本地状态完全丢失时必须通过 Web UI 重连；
- 明确拒绝基于机器属性的自动合并。
