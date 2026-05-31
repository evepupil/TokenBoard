import { RotateCcw } from 'lucide'
import { Button, LinkButton } from '../../../components/ui/button'
import { CustomSelect, customSelectOptions } from '../../../components/ui/custom-select'
import { LucideIcon } from '../../../components/ui/icon'
import { Input, Label } from '../../../components/ui/input'
import {
  publicCardGlowPositions,
  publicCardLanguages,
  publicCardLayouts,
  publicCardMetricSlotCount,
  publicCardMetrics,
  publicCardThemes,
  type PublicCardConfig,
  type PublicCardMetric
} from '../config'
import { renderUsageCardSvg, type UsageCardInput } from '../svg'

const metricLabels: Record<PublicCardMetric, string> = {
  totalTokens: '总 token',
  totalTokensWithoutCacheRead: '总量不含缓存读',
  totalCacheReadRate: '总缓存率',
  totalCost: '总费用',
  monthTokens: '本月 token',
  monthTokensWithoutCacheRead: '本月不含缓存读',
  monthCacheReadRate: '本月缓存率',
  monthCost: '本月费用',
  todayTokens: '今日 token',
  todayTokensWithoutCacheRead: '今日不含缓存读',
  todayCacheReadRate: '今日缓存率',
  todayCost: '今日费用'
}

const languageLabels: Record<PublicCardConfig['language'], string> = {
  zh: '中文',
  en: 'English'
}

const themeLabels: Record<PublicCardConfig['theme'], string> = {
  dark: '深色',
  light: '亮色'
}

const layoutLabels: Record<PublicCardConfig['layout'], string> = {
  balanced: '均衡',
  compact: '紧凑',
  wide: '宽幅'
}

const glowPositionLabels: Record<PublicCardConfig['glow']['position'], string> = {
  'top-right': '右上',
  'top-left': '左上',
  center: '居中'
}

export function PublicCardConfigEditor(props: {
  config: PublicCardConfig
  preview: UsageCardInput
  isPublic: boolean
}) {
  const previewSrc = svgDataUri(renderUsageCardSvg(props.preview, props.config))

  return (
    <div class="space-y-4 border-t border-[var(--app-border)] pt-5" data-public-card-config="true">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-black text-[var(--app-text)]">README 卡片外观</h2>
          <p class="text-xs text-[var(--app-muted)]">配置会应用到公开 SVG，未公开时仅生成本页预览。</p>
        </div>
        <span class="rounded-full border border-[var(--app-border)] px-2 py-1 text-xs font-bold text-[var(--app-muted)]">
          {props.isPublic ? '公开' : '私有预览'}
        </span>
      </div>

      <div class="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2">
        <img
          class="block h-auto w-full rounded-md"
          src={previewSrc}
          alt="TokenBoard README SVG 预览"
          width="520"
          height="220"
          loading="lazy"
          data-public-card-preview="true"
          data-public-card-public-url={props.preview.publicUrl}
        />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="语言"
          name="cardLanguage"
          value={props.config.language}
          options={publicCardLanguages}
          labels={languageLabels}
        />
        <SelectField
          label="主题"
          name="cardTheme"
          value={props.config.theme}
          options={publicCardThemes}
          labels={themeLabels}
        />
        <SelectField
          label="布局"
          name="cardLayout"
          value={props.config.layout}
          options={publicCardLayouts}
          labels={layoutLabels}
        />
        <SelectField
          label="炫光位置"
          name="cardGlowPosition"
          value={props.config.glow.position}
          options={publicCardGlowPositions}
          labels={glowPositionLabels}
        />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <Label>
          标题
          <Input name="cardTitle" value={props.config.title} autocomplete="off" />
        </Label>
        <Label>
          副标题
          <Input name="cardSubtitle" value={props.config.subtitle} autocomplete="off" />
        </Label>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <ToggleField name="cardShowPublicUrl" checked={props.config.showPublicUrl} title="显示公开链接" />
        <ToggleField name="cardGlowEnabled" checked={props.config.glow.enabled} title="背景炫光" />
      </div>

      <Label>
        炫光强度
        <input
          class="mt-2 w-full accent-lime-300"
          type="range"
          name="cardGlowIntensity"
          min="0"
          max="1"
          step="0.05"
          value={String(props.config.glow.intensity)}
        />
      </Label>

      <div>
        <p class="mb-2 text-sm font-bold text-[var(--app-muted)]">指标顺序</p>
        <div class="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: publicCardMetricSlotCount }, (_, index) => (
            <MetricSlot index={index} value={props.config.metrics[index] ?? ''} />
          ))}
        </div>
      </div>

      <div class="flex flex-col gap-3 pt-1 sm:flex-row sm:flex-wrap">
        <Button class="w-full sm:w-auto" type="submit">保存设置</Button>
        <Button class="w-full sm:w-auto" type="submit" variant="secondary" name="cardAction" value="reset">
          <LucideIcon icon={RotateCcw} size={16} />
          还原默认卡片
        </Button>
        <LinkButton class="w-full sm:w-auto" variant="secondary" href="/dashboard">返回控制台</LinkButton>
      </div>
    </div>
  )
}

function SelectField<T extends string>(props: {
  label: string
  name: string
  value: T
  options: readonly T[]
  labels: Record<T, string>
}) {
  return (
    <CustomSelect
      label={props.label}
      name={props.name}
      value={props.value}
      options={customSelectOptions(props.options, props.labels)}
      wrapperClass="mt-2"
    />
  )
}

function ToggleField(props: { name: string; checked: boolean; title: string }) {
  return (
    <label class="flex min-h-11 items-center gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 text-sm font-bold text-[var(--app-text)]">
      <input class="h-4 w-4 accent-lime-300" type="checkbox" name={props.name} checked={props.checked} />
      {props.title}
    </label>
  )
}

function MetricSlot(props: { index: number; value: PublicCardMetric | '' }) {
  const name = `cardMetric${props.index + 1}`
  const options = ['', ...publicCardMetrics] as const
  const labels = {
    '': '不显示',
    ...metricLabels
  } satisfies Record<(typeof options)[number], string>

  return (
    <CustomSelect
      name={name}
      value={props.value}
      options={customSelectOptions(options, labels)}
      inputAttrs={{ 'data-card-metric-slot': 'true' }}
    />
  )
}

function svgDataUri(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
