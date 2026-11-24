import { createRoute } from 'honox/factory'
import { AppNav } from '../components/app-nav'
import {
  FolioCacheWaffle,
  FolioRotatedColumns,
  FolioStackedRibbon,
  FolioUnitMatrix
} from '../components/charts/folio-charts'
import { getOptionalUser } from '../features/auth/middleware'
import { renderUsageCardSvg } from '../features/public-card/svg'

const specimenPreviewInput = {
  displayName: 'Research Lab',
  publicUrl: 'tokenboard.dev/u/research',
  totalTokens: 1550420000,
  totalTokensWithoutCacheRead: 71110000,
  totalCacheReadRate: 0.954,
  totalCostUsd: 292.72,
  monthTokens: 482910000,
  monthTokensWithoutCacheRead: 26840000,
  monthCacheReadRate: 0.944,
  monthCostUsd: 94.18,
  todayTokens: 12842000,
  todayTokensWithoutCacheRead: 1940000,
  todayCacheReadRate: 0.849,
  todayCostUsd: 4.86,
  models: [
    { model: 'claude-sonnet-4-6', totalTokens: 578_200_000 },
    { model: 'gemini-4-hydrogen', totalTokens: 398_500_000 },
    { model: 'gpt-5.4-codex', totalTokens: 322_400_000 },
    { model: 'gemini-2.5-pro', totalTokens: 82_200_000 },
    { model: 'claude-opus-4-6', totalTokens: 66_700_000 },
    { model: 'deepseek-r1', totalTokens: 57_300_000 },
    { model: 'o3-mini', totalTokens: 45_120_000 }
  ],
  totalModelCount: 7,
  timezoneLabel: 'UTC+8',
  updatedAtLabel: '11-23 13:29'
}

export default createRoute(async (c) => {
  c.header('Cache-Control', 'no-store')

  const user = await getOptionalUser(c)
  if (user) {
    return c.redirect('/dashboard')
  }

  const lightBalancedSvg = svgDataUri(
    renderUsageCardSvg(specimenPreviewInput, {
      theme: 'light',
      layout: 'balanced',
      language: 'zh',
      showUpdatedAt: true,
      metrics: ['totalTokens', 'monthTokens', 'totalCacheReadRate', 'totalCost']
    })
  )
  const darkWideSvg = svgDataUri(
    renderUsageCardSvg(specimenPreviewInput, {
      theme: 'dark',
      layout: 'wide',
      language: 'en',
      showUpdatedAt: true,
      metrics: ['totalTokens', 'totalCacheReadRate', 'totalCost']
    })
  )
  const lightCompactSvg = svgDataUri(
    renderUsageCardSvg(specimenPreviewInput, {
      theme: 'light',
      layout: 'compact',
      language: 'zh',
      showUpdatedAt: true,
      metrics: [
        'totalTokens',
        'totalTokensWithoutCacheRead',
        'totalCacheReadRate',
        'monthTokens',
        'monthCost',
        'todayTokens'
      ]
    })
  )

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-8 sm:py-6">
      <title>TokenBoard - AI 算力用量与遥测面板</title>
      <AppNav isAuthenticated={false} />

      <div class="app-folio-container space-y-20 pb-16">
        {/* ================================================================
            CHAPTER 01 — COVER SPREAD & INTERACTIVE 200-CELL UNIT MATRIX
           ================================================================ */}
        <section id="s01" class="space-y-8">
          <div class="grid grid-cols-[minmax(0,1fr)] items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-12">
            <div class="relative z-10 min-w-0">
              <p class="app-folio-kicker">01 — 全景总览</p>
              <h1 class="app-folio-display mt-3 max-w-full [overflow-wrap:anywhere] sm:max-w-4xl">
                本地 AI 模型
                <br />
                算力用量与成本
                <br />
                全息观察室。
              </h1>
              <div class="mt-6 border-t border-[var(--app-border-strong)] pt-5">
                <p class="max-w-full text-[16px] leading-7 text-[var(--app-muted)] [overflow-wrap:anywhere] sm:max-w-2xl">
                  统一采集 Claude Code、Codex、Antigravity、OpenCode、Pi、Grok Build、DeepSeek Harness 等 21 个本地 AI
                  工具用量。按日、来源与模型自动聚合 Token 吞吐、Prompt Cache 命中率与计费开销，生成研究型公开排行榜与
                  GitHub README SVG 遥测卡片。
                </p>
              </div>
              <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <a
                  class="inline-flex min-h-11 items-center justify-center border border-[var(--app-border-strong)] bg-[var(--app-text)] px-6 py-2.5 text-sm font-bold text-[var(--app-bg)] transition hover:border-[var(--app-accent-bar)] hover:bg-[var(--app-accent-bar)] hover:text-[var(--app-accent-bar-ink)]"
                  data-link-button="true"
                  href="/auth/sign-in"
                >
                  使用 GitHub 登录 →
                </a>
                <a
                  class="inline-flex min-h-11 items-center justify-center border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] px-6 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-text)] hover:text-[var(--app-bg)]"
                  data-link-button="true"
                  href="/leaderboards"
                >
                  浏览公开排行榜 ↓
                </a>
              </div>
              <p class="mt-4 font-mono text-xs leading-5 text-[var(--app-subtle)]">
                本地采集器仅上传脱敏汇总快照（Token / 模型 / 日期 / 会话数） · 零对话原文上传 · 支持 macOS / Linux /
                Windows
              </p>
            </div>

            <div class="relative z-10 min-w-0 max-w-full overflow-hidden">
              <div class="flex flex-wrap justify-between gap-2">
                <p class="text-sm font-bold text-[var(--app-text)]">
                  单位矩阵图 · 共 3.20B（每 1 个方块 ≈ 8.0M Tokens）
                </p>
                <span class="font-mono text-xs text-[var(--app-subtle)]">FIG. 01</span>
              </div>

              {/* Interactive Folio Segmented Dimension Control matching Folio #s01 */}
              <div class="app-segmented mt-3" role="group" aria-label="切换矩阵分组维度">
                <button
                  type="button"
                  class="app-segmented-btn"
                  aria-pressed="true"
                  data-folio-matrix-button="all"
                  data-folio-matrix-group="hero-matrix"
                >
                  全部
                </button>
                <button
                  type="button"
                  class="app-segmented-btn"
                  aria-pressed="false"
                  data-folio-matrix-button="model"
                  data-folio-matrix-group="hero-matrix"
                >
                  按模型
                </button>
                <button
                  type="button"
                  class="app-segmented-btn"
                  aria-pressed="false"
                  data-folio-matrix-button="source"
                  data-folio-matrix-group="hero-matrix"
                >
                  按工具源
                </button>
                <button
                  type="button"
                  class="app-segmented-btn"
                  aria-pressed="false"
                  data-folio-matrix-button="tokenType"
                  data-folio-matrix-group="hero-matrix"
                >
                  按 Token 类型
                </button>
              </div>

              <div class="mt-4">
                <FolioUnitMatrix
                  initialMode="all"
                  ariaLabel="全周期 3.20B Tokens 映射到 400 格交互单位矩阵，支持按模型、工具源与 Token 类型动态重组"
                />
              </div>

              <div class="mt-4 border-t border-[var(--app-border)] pt-2.5">
                <p class="app-fig-caption">
                  FIG. 01 — 全周期 3.20B Tokens 映射到 400 格单位矩阵（每 1 个方块 ≈
                  8.0M）；点击上方维度即时重组动画，悬浮任意分组查看明细。
                </p>
              </div>
            </div>
          </div>

          {/* Full-width 4-Column Hairline KPI Strip matching Folio Cover bottom */}
          <div class="app-folio-rule" aria-label="核心遥测指标示例">
            <div class="grid grid-cols-1 divide-y divide-[var(--app-border)] sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
              <CoverKpi
                value="128,420"
                caption="今日消耗 Tokens · 覆盖 3 个来源"
                annotation="不含缓存读 97,850 · 缓存命中 23.8%"
              />
              <CoverKpi
                value="3.20B"
                caption="全周期累计吞吐 · 缓存读 2.94B"
                annotation="新增输入 192M · 输出生成 64M"
              />
              <CoverKpi value="$292.72" caption="已记录计费开销（USD）" annotation="动态定价目录 · 未计费源清晰标注" />
              <CoverKpi
                value="95.4%"
                caption="全局 Prompt Cache 复用命中率"
                annotation="↑ 20.7× 缓存复用倍率 · 21 工具源"
              />
            </div>
            <div class="border-t border-[var(--app-border)]" />
          </div>
        </section>

        {/* ================================================================
            CHAPTER 02 — BOOK SPREAD: 100% STACKED RIBBON + 10×10 CACHE WAFFLE
           ================================================================ */}
        <section id="s02" class="app-folio-chapter-rule pt-14">
          <div class="app-folio-spread">
            <div class="app-folio-spread-left space-y-10">
              <div>
                <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <h3 class="text-sm font-bold text-[var(--app-text)]">100% 堆叠算力构成（按来源）</h3>
                  <span class="font-mono text-xs text-[var(--app-subtle)]">FIG. 02A</span>
                </div>
                <FolioStackedRibbon
                  ariaLabel="多工具来源 100% 堆叠占比：Claude Code 55%，Codex 28%，Antigravity 11%，OpenCode 6%"
                  segments={[
                    { label: 'Claude Code', share: 0.55, detail: '1,760M', tone: 1 },
                    { label: 'Codex', share: 0.28, detail: '896M', tone: 2 },
                    { label: 'Antigravity', share: 0.11, detail: '352M', tone: 3 },
                    { label: 'OpenCode', share: 0.06, detail: '192M', tone: 4 }
                  ]}
                />
                <p class="app-fig-caption mt-3 border-t border-[var(--app-border)] pt-2.5">
                  FIG. 02A — 控制台实时拆解各客户端来源的 Token 与费用重心，支持按日与按设备交叉钻取。
                </p>
              </div>

              <div class="border-t border-[var(--app-border)] pt-8">
                <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <h3 class="text-sm font-bold text-[var(--app-text)]">10×10 Prompt Cache 复用华夫格</h3>
                  <span class="font-mono text-xs text-[var(--app-subtle)]">FIG. 02B</span>
                </div>
                <FolioCacheWaffle
                  cacheHitRate={0.95}
                  freshInputRate={0.05}
                  patternId="home-cache-hatch"
                  caption="FIG. 02B — 每 100 个消耗 Token 中，实心格代表缓存读取命中，斜纹格代表新增输入与缓存写入。"
                />
              </div>
            </div>

            <div class="app-folio-spread-right flex flex-col justify-between">
              <div>
                <p class="app-folio-kicker">02 — 结构拆解与缓存效率</p>
                <h2 class="app-folio-h2 mt-3">
                  透视多工具流量、
                  <br />
                  缓存复用红利与
                  <br />
                  账单重心分布。
                </h2>
                <div class="mt-6 border-t border-[var(--app-border-strong)] pt-6">
                  <div class="grid gap-6 text-[15px] leading-7 text-[var(--app-muted)] sm:grid-cols-2">
                    <p>
                      在高频多轮 Agent 编程工作流中，仅看总 Token 容易失真。TokenBoard 同时计量
                      <strong class="text-[var(--app-text)]">总 Tokens</strong>、
                      <strong class="text-[var(--app-text)]">不含缓存读</strong>与
                      <strong class="text-[var(--app-text)]">Prompt Cache 命中率</strong>，还原真实的上下文开销。
                    </p>
                    <p>
                      对于 Antigravity、Grok Build、DeepSeek Harness 等不提供官方费用的来源，全站控制台、日报与 README
                      卡片均显式标注「费用不可用」，绝不虚构估算成本。
                    </p>
                  </div>
                </div>
              </div>

              <div class="mt-10 border-t border-[var(--app-border)] pt-6">
                <div class="grid grid-cols-3 gap-4">
                  <div>
                    <p class="text-3xl font-medium tracking-tight tabular-nums text-[var(--app-text)] sm:text-4xl">
                      95.4%
                    </p>
                    <p class="mt-1 text-xs leading-5 text-[var(--app-muted)]">典型多轮 Agent 缓存命中率</p>
                  </div>
                  <div>
                    <p class="text-3xl font-medium tracking-tight tabular-nums text-[var(--app-text)] sm:text-4xl">
                      21
                    </p>
                    <p class="mt-1 text-xs leading-5 text-[var(--app-muted)]">内置标准化的本地工具来源</p>
                  </div>
                  <div>
                    <p class="text-3xl font-medium tracking-tight tabular-nums text-[var(--app-text)] sm:text-4xl">0</p>
                    <p class="mt-1 text-xs leading-5 text-[var(--app-muted)]">上传至云端的对话正文字节</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================================================================
            CHAPTER 03 — BOOK SPREAD: GIANT ROTATED COLUMNS + README SVG SPECIMENS
           ================================================================ */}
        <section id="s03" class="app-folio-chapter-rule pt-14">
          <div class="app-folio-spread">
            <div class="app-folio-spread-left">
              <div class="mb-5 flex flex-wrap items-center justify-between gap-2">
                <h3 class="text-sm font-bold text-[var(--app-text)]">来源集中度结构（主力 / 次主力 / 长尾）</h3>
                <span class="font-mono text-xs text-[var(--app-subtle)]">FIG. 03A</span>
              </div>
              <FolioRotatedColumns
                ariaLabel="来源集中度分布：主力 Top 1 占 55%，次主力占 28%，长尾来源占 17%"
                items={[
                  { label: '主力 Top 1', share: 0.55, tone: 1 },
                  { label: '次主力 2–3', share: 0.28, tone: 2 },
                  { label: '长尾工具源', share: 0.17, tone: 3 }
                ]}
              />
              <p class="app-fig-caption mt-4 border-t border-[var(--app-border)] pt-2.5">
                FIG. 03A — 三柱巨型旋转数字图直观衡量个人算力在主力工具、次主力梯队与长尾来源之间的集中度结构。
              </p>
            </div>

            <div class="app-folio-spread-right space-y-6">
              <div>
                <p class="app-folio-kicker">03 — 公开遥测卡片 · README SVG</p>
                <h2 class="app-folio-h2 mt-3">
                  可嵌入 GitHub README 的
                  <br />
                  研究日志 SVG 卡片。
                </h2>
                <div class="mt-5 border-t border-[var(--app-border-strong)] pt-5">
                  <p class="text-[15px] leading-7 text-[var(--app-muted)]">
                    固定 520×220 矢量规格，与全站同一套档案纸细线书册排版：上方采用大字数字 +
                    细线描述的指标带，下方嵌入热力图式模型单元矩阵，低占比长尾模型自动归并为「其他 N
                    个模型」，支持浅深双主题与三种版式。
                  </p>
                </div>
              </div>

              <div class="app-segmented" role="group" aria-label="切换 README SVG 卡片样张">
                <button
                  type="button"
                  class="app-segmented-btn"
                  aria-pressed="true"
                  data-folio-tab-button="true"
                  data-folio-tab-group="svg-specimen"
                  data-folio-tab-value="light-balanced"
                >
                  浅色 · 均衡四格
                </button>
                <button
                  type="button"
                  class="app-segmented-btn"
                  aria-pressed="false"
                  data-folio-tab-button="true"
                  data-folio-tab-group="svg-specimen"
                  data-folio-tab-value="dark-wide"
                >
                  深色 · 宽幅三列
                </button>
                <button
                  type="button"
                  class="app-segmented-btn"
                  aria-pressed="false"
                  data-folio-tab-button="true"
                  data-folio-tab-group="svg-specimen"
                  data-folio-tab-value="light-compact"
                >
                  浅色 · 紧凑六格
                </button>
              </div>

              <div class="border border-[var(--app-border-strong)] bg-[var(--app-panel)] p-3">
                <div data-folio-tab-panel="light-balanced" data-folio-tab-group="svg-specimen">
                  <img
                    class="block h-auto w-full"
                    src={lightBalancedSvg}
                    alt="TokenBoard 浅色均衡四格 README SVG 卡片预览"
                    width="520"
                    height="220"
                  />
                </div>
                <div data-folio-tab-panel="dark-wide" data-folio-tab-group="svg-specimen" hidden>
                  <img
                    class="block h-auto w-full"
                    src={darkWideSvg}
                    alt="TokenBoard 深色宽幅三列 README SVG 卡片预览"
                    width="520"
                    height="220"
                  />
                </div>
                <div data-folio-tab-panel="light-compact" data-folio-tab-group="svg-specimen" hidden>
                  <img
                    class="block h-auto w-full"
                    src={lightCompactSvg}
                    alt="TokenBoard 浅色紧凑六格 README SVG 卡片预览"
                    width="520"
                    height="220"
                  />
                </div>
              </div>
              <p class="app-fig-caption">
                FIG. 03B — 实时由服务端 `renderUsageCardSvg` 渲染；登录后可在「公开资料」中自由编排指标顺序与主题。
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
})

function CoverKpi(props: { value: string; caption: string; annotation: string }) {
  return (
    <div class="px-0 py-6 sm:px-5 lg:first:pl-0 lg:last:pr-0">
      <p class="app-folio-kpi-num text-[var(--app-text)]">{props.value}</p>
      <p class="mt-3 text-sm font-medium text-[var(--app-text)]">{props.caption}</p>
      <p class="app-accent-text mt-1 font-mono text-xs font-medium">{props.annotation}</p>
    </div>
  )
}

function svgDataUri(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
