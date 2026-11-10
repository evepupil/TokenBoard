# Go 客户端 S5 发布说明：不再下载或执行 ccusage

- 日期：2026-11-10
- 分支：`feat/native-usage-sources`（S1–S5 全部落地；S5 起点 `0552790`，收尾 `f4f76c9`）
- 面向读者：装过二进制客户端（`clientType: binary`）的用户，以及准备切换的人

## 1. 一句话

Go 客户端自己读各工具的本地记录，**不再下载、执行或分发 `ccusage`**；升级后机器上原有的
`~/.tokenboard/bin/ccusage` 原样留下、不再被调用、也不会被删除。

## 2. 对用户可见的变化

### 2.1 安装与升级

- 发布归档只剩 `README.md` 与 `tokenboard[.exe]`。`checksums.txt`、资产名、`tar.gz` 形态不变，
  自更新流程（下载 → 校验 → `version` 验证 → 换入 → 保留 `.backup-<UTC>`）不变。
- 从带捆绑 ccusage 的版本升级时，`self-update` 会打印一次
  `TokenBoard updated to <version>; the client no longer bundles or uses ccusage, so the existing <path> is left in place`。
  这是提示，不是错误；`status.mjs` 仍会显示 `ccusagePresent` / `ccusageVersion`。
- `TOKENBOARD_PACKAGE_MANAGER` 与 `TOKENBOARD_CCUSAGE_BIN` / `TOKENBOARD_FORCE_PACKAGE_RUNNER` 不再被
  Go 客户端读取（前者只对 `clientType: git` 的 TS checkout 生效）。`TOKENBOARD_CCUSAGE_CONFIG`
  **保留**：用户自己写的显式定价覆盖表仍然生效（`claudecode/native.go`、`codex/provider.go`、
  `ccusagetool/ccusagetool.go` 都读它）。`TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG` 仍由 Go 侧内部生成。

### 2.2 Claude Code 费用的口径变化（请重点看这一条）

Go 客户端的价格来自与 `ccusage@20.0.33` 构建期快照逐位一致的冻结语料（`internal/nativepricing`，
含 `packages/collector/ccusage.json` 的 override）。它等于 `ccusage --offline`，**不等于**在线
ccusage 的 LiteLLM 实时价表。

本机 7 天窗口（2026-11-02 至 11-08，`Asia/Shanghai`）实测：在线 **9388.10 USD**、离线/native
**8669.30 USD**，native 比在线低 **7.7%**。差额几乎全部来自 `deepseek-v4.1-flash` 系列的费率
差异（LiteLLM 实时表与冻结快照双向都不等），不是漏模型。这是 `spec §2 G2` 已定义的边界。

相关的小改动：唯一真正漏价的 `hy4-free`（约 $7/周）已补 override，现按 `hy4` 同费率计费。
`step-5-preview` 沿用 `step-5-preview-free` 的置零约定；`group/auto-dfmodel`、`deepseek_for_coding`、
`kimi-k3.1` 在在线与离线两侧都计 0，无实费影响。完整数据见
`docs/research/2026-11-10-s5-flip-coverage.md`。

**影响**：翻到 native 后，claude-code 的历史与新增费用都会按离线口径计算。已经入库的历史快照
不会被回算（AGENTS.md 的约定：动态定价只作用于新采集），因此看到费用台阶属预期。

### 2.3 性能

同机 5 轮中位数（2026-11-10，机器负载 76–142，只看中位数）：

| 来源 / 场景 | ccusage 墙钟 | native 墙钟 | ccusage 峰值 RSS | native 峰值 RSS |
|---|---|---|---|---|
| codex 单日 | 2m05.9s | **13.7s** | 181.8 MiB | **41.1 MiB** |
| codex 近 30 天 | 2m03.9s | **34.4s** | 189.3 MiB | **52.3 MiB** |
| claude 单日 | 3m51.4s | **2m42.9s** | 2.81 GiB | **1.74 GiB** |
| claude 近 30 天 | 5m42.7s | **4m12.3s** | 3.40 GiB | **3.16 GiB** |

Codex 是量级差（墙钟 −72%～−89%），claude 是中等差（−26%～−30%）。**全量历史场景可能更慢**：
2026-11-05 的记录显示 native 墙钟比 ccusage 高约 22%，S5 未改变该路径，本次也未重测。方法、原始
输出与未覆盖边界见 `docs/research/2026-11-10-native-vs-ccusage-benchmark.md`。

### 2.4 回滚

不需要改代码：`mergeConfig({ clientType: 'git' })`（`config.mjs` 的 `readClientType` 在缺省时也用
`git`，与 `upgrade.mjs --to-binary` 写入的值对称）即可回到 TS checkout 客户端，ccusage 由 pnpm
依赖提供。**不要手改 JSON 的根级 `clientType`**——多服务器配置下根字段会被 profile-scoped 值覆盖。

## 3. 未覆盖边界

- 金样本（行级 `--json` 原始输出）覆盖 14/14 个 ccusage 兼容来源，但只来自 `ccusage 20.0.33`
  读固定夹具树一次，工具类每个报告 1–3 行；重新生成依赖仓库外的 ccusage 二进制。
- claude 金样本只覆盖 parser 接受路径，不含线级拒绝与窗口剪枝（`adapters/claude/goldens_test.go` 头条注释）。
- 性能数据只在 darwin 实测；Windows / Linux 无真机数据（CI 只做编译与测试）。
- TS collector（`clientType: git`，缺省值）行为不变，仍调用 `ccusage@20.0.33`。
