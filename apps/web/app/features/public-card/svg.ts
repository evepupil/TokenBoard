import {
  defaultPublicCardConfig,
  parsePublicCardConfig,
  type PublicCardConfig,
  type PublicCardMetric
} from './config'

export type UsageCardInput = {
  displayName: string
  publicUrl: string
  totalTokens: number
  totalCostUsd: number
  monthTokens: number
  monthCostUsd: number
  todayTokens?: number
  todayCostUsd?: number
}

type Palette = {
  bgStart: string
  bgEnd: string
  panel: string
  panelStrong: string
  text: string
  muted: string
  border: string
  logoPanelStart: string
  logoPanelEnd: string
  shadow: string
  highlightText: string
}

const palettes = {
  dark: {
    bgStart: '#161a13',
    bgEnd: '#0c0d0a',
    panel: '#151812',
    panelStrong: '#10130f',
    text: '#fafaf9',
    muted: '#a8a29e',
    border: '#78716c',
    logoPanelStart: '#272a22',
    logoPanelEnd: '#11130f',
    shadow: '#090a08',
    highlightText: '#bef264'
  },
  light: {
    bgStart: '#fffef8',
    bgEnd: '#ede6d8',
    panel: '#f8f4ec',
    panelStrong: '#ffffff',
    text: '#1c1917',
    muted: '#57534e',
    border: '#a8a29e',
    logoPanelStart: '#f8f4ec',
    logoPanelEnd: '#e7dccb',
    shadow: '#f4f0e8',
    highlightText: '#365314'
  }
} as const satisfies Record<PublicCardConfig['theme'], Palette>

export function renderUsageCardSvg(input: UsageCardInput, configInput?: Partial<PublicCardConfig> | null) {
  const config = parsePublicCardConfig(configInput ? { ...defaultPublicCardConfig, ...configInput } : null)
  const palette = palettes[config.theme]
  const metrics = buildMetricBlocks(input, config)
  const title = config.title || labels(config.language).title
  const subtitle = config.subtitle || subtitleText(input, config)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="220" viewBox="0 0 520 220" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <defs>
    <linearGradient id="card-bg" x1="0" y1="0" x2="520" y2="220" gradientUnits="userSpaceOnUse">
      <stop stop-color="${palette.bgStart}"/>
      <stop offset="1" stop-color="${palette.bgEnd}"/>
    </linearGradient>
    ${glowDefinition(config)}
    <linearGradient id="card-logo-panel" x1="96" y1="48" x2="416" y2="464" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.logoPanelStart}"/>
      <stop offset="1" stop-color="${palette.logoPanelEnd}"/>
    </linearGradient>
    <linearGradient id="card-logo-lime" x1="132" y1="108" x2="380" y2="404" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ecfccb"/>
      <stop offset="0.42" stop-color="#bef264"/>
      <stop offset="1" stop-color="#84cc16"/>
    </linearGradient>
  </defs>
  <rect width="520" height="220" rx="16" fill="url(#card-bg)"/>
  ${config.glow.enabled ? '<rect width="520" height="220" rx="16" fill="url(#glow)"/>' : ''}
  <rect x="0.5" y="0.5" width="519" height="219" rx="15.5" fill="none" stroke="${palette.border}" stroke-opacity="0.36"/>
  ${logoMark(palette)}
  <text x="94" y="41" fill="${palette.text}" font-family="Arial, sans-serif" font-size="20" font-weight="800">${escapeXml(title)}</text>
  <text x="94" y="64" fill="${palette.muted}" font-family="Arial, sans-serif" font-size="13">${escapeXml(subtitle)}</text>
  ${metrics.join('\n  ')}
</svg>`
}

function buildMetricBlocks(input: UsageCardInput, config: PublicCardConfig) {
  const slots = metricSlots(config)
  return config.metrics.slice(0, slots.length).map((metric, index) => {
    const slot = slots[index]
    return metricBlock({
      ...slot,
      label: labels(config.language).metrics[metric],
      value: metricValue(input, metric),
      highlight: index === 0,
      palette: palettes[config.theme]
    })
  })
}

function metricSlots(config: PublicCardConfig) {
  if (config.layout === 'compact') {
    return [
      { x: 24, y: 96, width: 148 },
      { x: 186, y: 96, width: 148 },
      { x: 348, y: 96, width: 148 },
      { x: 24, y: 154, width: 148 },
      { x: 186, y: 154, width: 148 },
      { x: 348, y: 154, width: 148 }
    ]
  }

  if (config.layout === 'wide') {
    return [
      { x: 24, y: 96, width: 472 },
      { x: 24, y: 154, width: 226 },
      { x: 270, y: 154, width: 226 }
    ]
  }

  return [
    { x: 24, y: 94, width: 226 },
    { x: 270, y: 94, width: 226 },
    { x: 24, y: 152, width: 226 },
    { x: 270, y: 152, width: 226 }
  ]
}

function labels(language: PublicCardConfig['language']) {
  if (language === 'en') {
    return {
      title: 'TokenBoard Stats',
      metrics: {
        totalTokens: 'Total Tokens',
        totalCost: 'Total Cost',
        monthTokens: 'Monthly Tokens',
        monthCost: 'Monthly Cost',
        todayTokens: 'Today Tokens',
        todayCost: 'Today Cost'
      } satisfies Record<PublicCardMetric, string>
    }
  }

  return {
    title: 'TokenBoard 统计',
    metrics: {
      totalTokens: '总 token',
      totalCost: '总额度',
      monthTokens: '本月 token',
      monthCost: '本月额度',
      todayTokens: '今日 token',
      todayCost: '今日额度'
    } satisfies Record<PublicCardMetric, string>
  }
}

function subtitleText(input: UsageCardInput, config: PublicCardConfig) {
  if (!config.showPublicUrl) return input.displayName
  return `${input.displayName} · ${input.publicUrl}`
}

function metricValue(input: UsageCardInput, metric: PublicCardMetric) {
  const values = {
    totalTokens: formatInteger(input.totalTokens),
    totalCost: formatUsd(input.totalCostUsd),
    monthTokens: formatInteger(input.monthTokens),
    monthCost: formatUsd(input.monthCostUsd),
    todayTokens: formatInteger(input.todayTokens ?? 0),
    todayCost: formatUsd(input.todayCostUsd ?? 0)
  } satisfies Record<PublicCardMetric, string>
  return values[metric]
}

function glowDefinition(config: PublicCardConfig) {
  const centers = {
    'top-right': { cx: '86%', cy: '10%' },
    'top-left': { cx: '14%', cy: '10%' },
    center: { cx: '50%', cy: '40%' }
  }
  const center = centers[config.glow.position]
  return `<radialGradient id="glow" cx="${center.cx}" cy="${center.cy}" r="56%">
      <stop stop-color="#bef264" stop-opacity="${config.glow.intensity.toFixed(2)}"/>
      <stop offset="1" stop-color="#bef264" stop-opacity="0"/>
    </radialGradient>`
}

function logoMark(palette: Palette) {
  return `<g transform="translate(22 18) scale(0.118)">
    <rect width="512" height="512" rx="104" fill="${palette.shadow}"/>
    <rect x="42" y="42" width="428" height="428" rx="82" fill="url(#card-logo-panel)"/>
    <rect x="66" y="66" width="380" height="380" rx="62" fill="none" stroke="#bef264" stroke-opacity="0.16" stroke-width="4"/>
    <g opacity="0.42" stroke="#f7fee7" stroke-width="2">
      <path d="M118 166H394"/>
      <path d="M118 246H394"/>
      <path d="M118 326H394"/>
      <path d="M176 118V386"/>
      <path d="M256 118V386"/>
      <path d="M336 118V386"/>
    </g>
    <g fill="url(#card-logo-lime)">
      <path d="M130 118H282V164H229V382H181V164H130V118Z"/>
      <path d="M280 118H352C389 118 415 143 415 178C415 200 404 218 386 228C410 238 425 260 425 287C425 324 397 350 356 350H280V118ZM328 164V211H348C360 211 368 201 368 187C368 173 360 164 347 164H328ZM328 253V304H354C369 304 377 294 377 278C377 263 368 253 353 253H328Z"/>
    </g>
    <g fill="#11130f">
      <rect x="145" y="296" width="18" height="54" rx="9"/>
      <rect x="185" y="260" width="18" height="90" rx="9"/>
      <rect x="225" y="224" width="18" height="126" rx="9"/>
    </g>
    <path d="M120 390H392" stroke="#bef264" stroke-opacity="0.72" stroke-width="12" stroke-linecap="round"/>
  </g>`
}

function metricBlock(input: {
  x: number
  y: number
  width: number
  label: string
  value: string
  highlight: boolean
  palette: Palette
}) {
  const valueFill = input.highlight ? input.palette.highlightText : input.palette.text
  return `<g>
      <rect x="${input.x}" y="${input.y}" width="${input.width}" height="44" rx="10" fill="${input.highlight ? '#bef264' : input.palette.panel}" fill-opacity="${input.highlight ? '0.14' : '0.78'}" stroke="${input.highlight ? '#bef264' : input.palette.border}" stroke-opacity="${input.highlight ? '0.45' : '0.28'}"/>
      <text x="${input.x + 14}" y="${input.y + 18}" fill="${input.palette.muted}" font-family="Arial, sans-serif" font-size="12">${escapeXml(input.label)}</text>
      <text x="${input.x + 14}" y="${input.y + 35}" fill="${valueFill}" font-family="Arial, sans-serif" font-size="18" font-weight="800">${escapeXml(input.value)}</text>
    </g>`
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatUsd(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
