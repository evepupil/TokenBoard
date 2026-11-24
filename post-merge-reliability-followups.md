# Post-Merge Reliability Follow-ups

> 历史归档。`fix/post-merge-reliability-followups` 分支已合并（经 PR #25 进入上游 master）。
> 原文件是那条分支的逐项验收台账，1866 行；这里只保留结论与仍然有效的约束。
> 当前工作树状态请看 `git status`，当前审计记录见 `docs/research/`。

## 目标

完成 `fix/post-merge-reliability-followups` 相对基线 `c43b67c` 的全部可靠性、兼容性、
数据正确性、客户端运行、D1 migration、质量安全、独立复核、私人 Cloudflare 验证、
原子提交、推送与中文 PR 收尾。

## 逐项结果（T01–T10）

| 项 | 范围 | 结果 |
| --- | --- | --- |
| T01 | 基线与工作树保护 | 完成 |
| T02 | Antigravity CLI 计量与 cursor 正确性 | 完成 |
| T03 | 五来源 `--since` 窗口与 GUI/IDE 可靠性 | 完成 |
| T04 | Hook / statusline 锁 / 多 server 恢复 | 完成 |
| T05 | Web、D1 与旧 client 兼容 | 完成 |
| T06 | 代码、测试与文档治理 | 完成 |
| T07 | 本机 client 与近月数据核验 | 完成（2026-09-05 候选复核） |
| T08 | 质量、安全与文档门禁 | 完成（2026-09-07） |
| T09 | 独立只读复核 | 完成；OMP 当时按用户指示跳过，记为未覆盖 |
| T10 | 私人 Cloudflare 部署、提交与 PR | 完成（该分支已合并） |

## 仍然有效的约束（已并入 AGENTS.md 与 specs）

- Antigravity 三类来源的 SQLite history 是唯一上传计量权威；statusline 只写本地脱敏诊断，
  不参与 snapshot/上传计量。
- `--since all` 必须执行 canonical rebuild；有界窗口只能复用可证明兼容的游标。
- language-server metadata 响应必须限长，只投影 usage 字段；原始内容不得进入 cursor、日志、
  snapshot 或上传 payload。
- 采集限长时原样转发 stdin；原命令成功输出即使遇到转发 EPIPE 也必须输出。
- reconnect pairing 的并发撤销/claim 变化必须用零行写入表达；service 把 stale pairing 映射为
  401、失效 target/source installation 映射为 404。
- 过大的测试文件按 fixture / cursor lifecycle / CLI contract / source parsing 拆分；无法安全
  拆分时在 `docs/reviews/` 记录豁免理由。

## 保留的证据文档

- `docs/reviews/CR-T08-MANUAL-DIFF-SECURITY-2026-07-23.md` — 人工安全审阅
- `docs/reviews/CR-TEST-FILE-SIZE-2026-07-20.md` — 测试文件大小豁免
- `docs/reviews/CR-PRE-PUSH-REVIEW-2026-08-01.md` — 推送前复核
- `docs/reviews/UPSTREAM-PRODUCTION-RECOVERY-2026-07-16.md` — 上游生产恢复
