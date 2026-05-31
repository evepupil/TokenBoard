import { z } from 'zod'

export const publicCardLanguages = ['zh', 'en'] as const
export const publicCardThemes = ['dark', 'light'] as const
export const publicCardLayouts = ['balanced', 'compact', 'wide'] as const
export const publicCardGlowPositions = ['top-right', 'top-left', 'center'] as const
export const publicCardMetrics = [
  'totalTokens',
  'totalTokensWithoutCacheRead',
  'totalCacheReadRate',
  'totalCost',
  'monthTokens',
  'monthTokensWithoutCacheRead',
  'monthCacheReadRate',
  'monthCost',
  'todayTokens',
  'todayTokensWithoutCacheRead',
  'todayCacheReadRate',
  'todayCost'
] as const

export const publicCardMetricSlotCount = 6

export type PublicCardMetric = (typeof publicCardMetrics)[number]

export type PublicCardConfig = {
  language: (typeof publicCardLanguages)[number]
  theme: (typeof publicCardThemes)[number]
  layout: (typeof publicCardLayouts)[number]
  title: string
  subtitle: string
  showPublicUrl: boolean
  glow: {
    enabled: boolean
    intensity: number
    position: (typeof publicCardGlowPositions)[number]
  }
  metrics: PublicCardMetric[]
}

export const defaultPublicCardMetricOrder: PublicCardMetric[] = [
  'totalTokens',
  'totalCost',
  'monthTokens',
  'monthCost'
]

export const defaultPublicCardConfig: PublicCardConfig = {
  language: 'zh',
  theme: 'dark',
  layout: 'balanced',
  title: '',
  subtitle: '',
  showPublicUrl: true,
  glow: {
    enabled: true,
    intensity: 0.28,
    position: 'top-right'
  },
  metrics: [...defaultPublicCardMetricOrder]
}

const publicCardMetricSchema = z.enum(publicCardMetrics)

export const publicCardConfigSchema = z.object({
  language: z.enum(publicCardLanguages).default(defaultPublicCardConfig.language),
  theme: z.enum(publicCardThemes).default(defaultPublicCardConfig.theme),
  layout: z.enum(publicCardLayouts).default(defaultPublicCardConfig.layout),
  title: z.string().trim().max(48).default(defaultPublicCardConfig.title),
  subtitle: z.string().trim().max(96).default(defaultPublicCardConfig.subtitle),
  showPublicUrl: z.boolean().default(defaultPublicCardConfig.showPublicUrl),
  glow: z.object({
    enabled: z.boolean().default(defaultPublicCardConfig.glow.enabled),
    intensity: z.number().min(0).max(1).default(defaultPublicCardConfig.glow.intensity),
    position: z.enum(publicCardGlowPositions).default(defaultPublicCardConfig.glow.position)
  }).default(defaultPublicCardConfig.glow),
  metrics: z.array(publicCardMetricSchema)
    .transform((metrics) => metrics.slice(0, publicCardMetricSlotCount))
    .default([...defaultPublicCardConfig.metrics])
    .transform((metrics) => uniqueMetrics(metrics))
}).default(defaultPublicCardConfig)

export function parsePublicCardConfig(value: unknown): PublicCardConfig {
  if (value === null || value === undefined || value === '') return publicCardConfigSchema.parse(undefined)
  const parsed = typeof value === 'string' ? parseJson(value) : value
  const result = publicCardConfigSchema.safeParse(parsed)
  return result.success ? result.data : publicCardConfigSchema.parse(undefined)
}

export function stringifyPublicCardConfig(config: PublicCardConfig) {
  return JSON.stringify(publicCardConfigSchema.parse(config))
}

export function parsePublicCardConfigForm(form: Record<string, unknown>): PublicCardConfig | null {
  if (String(form.cardAction ?? '') === 'reset') return null

  return publicCardConfigSchema.parse({
    language: String(form.cardLanguage || defaultPublicCardConfig.language),
    theme: String(form.cardTheme || defaultPublicCardConfig.theme),
    layout: String(form.cardLayout || defaultPublicCardConfig.layout),
    title: String(form.cardTitle || ''),
    subtitle: String(form.cardSubtitle || ''),
    showPublicUrl: form.cardShowPublicUrl === 'on',
    glow: {
      enabled: form.cardGlowEnabled === 'on',
      intensity: Number(form.cardGlowIntensity ?? defaultPublicCardConfig.glow.intensity),
      position: String(form.cardGlowPosition || defaultPublicCardConfig.glow.position)
    },
    metrics: readMetricOrder(form)
  })
}

function readMetricOrder(form: Record<string, unknown>) {
  const slotIndexes = Array.from({ length: publicCardMetricSlotCount }, (_, index) => index)
  const hasMetricSlots = slotIndexes.some((index) =>
    Object.prototype.hasOwnProperty.call(form, `cardMetric${index + 1}`)
  )
  const slotMetrics = slotIndexes
    .map((index) => String(form[`cardMetric${index + 1}`] || '').trim())
    .filter(Boolean)

  if (hasMetricSlots) return slotMetrics.filter(isPublicCardMetric)

  const raw = String(form.cardMetrics || '')
    .split(',')
    .map((metric) => metric.trim())
    .filter(Boolean)
  return raw.length > 0 ? raw : [...defaultPublicCardConfig.metrics]
}

function isPublicCardMetric(metric: string): metric is PublicCardMetric {
  return publicCardMetrics.includes(metric as PublicCardMetric)
}

function uniqueMetrics(metrics: PublicCardMetric[]) {
  const seen = new Set<PublicCardMetric>()
  return metrics.filter((metric) => {
    if (seen.has(metric)) return false
    seen.add(metric)
    return true
  })
}

function parseJson(value: string) {
  try {
    return JSON.parse(value)
  } catch (_) {
    return {}
  }
}
