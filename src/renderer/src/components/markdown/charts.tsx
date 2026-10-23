import { useMemo, type ReactNode } from 'react'

export type ChartDatum = { label: string; value: number; color?: string }

const PALETTE = [
  '#3d8bfd',
  '#34c759',
  '#ff9f0a',
  '#ff453a',
  '#bf5af2',
  '#64d2ff',
  '#ffd60a',
  '#ac8e68',
  '#5e5ce6',
  '#30d158'
]

export function parseChartBlock(raw: string): { title?: string; data: ChartDatum[] } | null {
  const text = String(raw ?? '').trim()
  if (!text) return null

  // JSON object
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        const data = normalizeItems(parsed)
        return data.length ? { data } : null
      }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        const title = typeof obj.title === 'string' ? obj.title : undefined
        const items = obj.data ?? obj.items ?? obj.series ?? obj.values
        const data = normalizeItems(items)
        return data.length ? { title, data } : null
      }
    } catch {
      /* fall through to CSV-ish */
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  let title: string | undefined
  const data: ChartDatum[] = []
  for (const line of lines) {
    const titleMatch = line.match(/^(?:title|标题)\s*[:：]\s*(.+)$/i)
    if (titleMatch) {
      title = titleMatch[1].trim()
      continue
    }
    // label,value | label: value | label value
    const m =
      line.match(/^(.+?)\s*[,，|]\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/) ||
      line.match(/^(.+?)\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/) ||
      line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)\s*%?\s*$/)
    if (!m) continue
    const label = m[1].trim()
    const value = Number(m[2])
    if (!label || !Number.isFinite(value)) continue
    data.push({ label, value })
  }
  return data.length ? { title, data } : null
}

function normalizeItems(raw: unknown): ChartDatum[] {
  if (!Array.isArray(raw)) return []
  const out: ChartDatum[] = []
  for (const item of raw) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      out.push({ label: String(out.length + 1), value: item })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const label = String(row.label ?? row.name ?? row.key ?? row.x ?? '').trim()
    const value = Number(row.value ?? row.y ?? row.count ?? row.n)
    if (!label || !Number.isFinite(value)) continue
    const color = typeof row.color === 'string' ? row.color : undefined
    out.push({ label, value, ...(color ? { color } : {}) })
  }
  return out
}

function withColors(data: ChartDatum[]): Array<ChartDatum & { color: string }> {
  return data.map((item, index) => ({
    ...item,
    color: item.color || PALETTE[index % PALETTE.length]
  }))
}

export function PieOrDonutChart(props: {
  data: ChartDatum[]
  title?: string
  donut?: boolean
  size?: number
}): ReactNode {
  const size = props.size ?? 220
  const colored = useMemo(() => withColors(props.data.filter((d) => d.value > 0)), [props.data])
  const total = colored.reduce((sum, d) => sum + d.value, 0)
  if (!colored.length || total <= 0) {
    return <div className="md-chart-empty">暂无有效数据绘制图表</div>
  }

  const cx = size / 2
  const cy = size / 2
  const radius = size * 0.38
  const inner = props.donut ? radius * 0.58 : 0
  let angle = -Math.PI / 2
  const slices = colored.map((item) => {
    const sweep = (item.value / total) * Math.PI * 2
    const start = angle
    const end = angle + sweep
    angle = end
    return { ...item, start, end, sweep }
  })

  return (
    <div className={`md-chart ${props.donut ? 'donut' : 'pie'}`}>
      {props.title && <div className="md-chart-title">{props.title}</div>}
      <div className="md-chart-body">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={props.title || '饼图'}>
          {slices.map((slice) => {
            if (slice.sweep >= Math.PI * 2 - 1e-6) {
              return (
                <circle
                  key={slice.label}
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill={slice.color}
                  stroke="rgba(0,0,0,0.15)"
                  strokeWidth={1}
                />
              )
            }
            return (
              <path
                key={slice.label}
                d={donutSlicePath(cx, cy, radius, inner, slice.start, slice.end)}
                fill={slice.color}
                stroke="rgba(0,0,0,0.18)"
                strokeWidth={1}
              />
            )
          })}
          {props.donut && (
            <circle cx={cx} cy={cy} r={inner} fill="var(--bg-elevated, #151a21)" />
          )}
          {props.donut && (
            <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" className="md-chart-center">
              {formatCompact(total)}
            </text>
          )}
        </svg>
        <ul className="md-chart-legend">
          {colored.map((item) => {
            const pct = total > 0 ? (item.value / total) * 100 : 0
            return (
              <li key={item.label}>
                <span className="md-chart-swatch" style={{ background: item.color }} />
                <span className="md-chart-label">{item.label}</span>
                <span className="md-chart-value mono">
                  {formatCompact(item.value)} · {pct.toFixed(1)}%
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

export function BarChart(props: { data: ChartDatum[]; title?: string }): ReactNode {
  const colored = useMemo(() => withColors(props.data), [props.data])
  const max = Math.max(...colored.map((d) => Math.abs(d.value)), 1)
  if (!colored.length) return <div className="md-chart-empty">暂无有效数据绘制图表</div>
  return (
    <div className="md-chart bar">
      {props.title && <div className="md-chart-title">{props.title}</div>}
      <div className="md-bar-list">
        {colored.map((item) => (
          <div className="md-bar-row" key={item.label}>
            <div className="md-bar-label">{item.label}</div>
            <div className="md-bar-track">
              <div
                className="md-bar-fill"
                style={{ width: `${(Math.abs(item.value) / max) * 100}%`, background: item.color }}
              />
            </div>
            <div className="md-bar-value mono">{formatCompact(item.value)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function donutSlicePath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number
): string {
  const large = end - start > Math.PI ? 1 : 0
  const x0 = cx + Math.cos(start) * outer
  const y0 = cy + Math.sin(start) * outer
  const x1 = cx + Math.cos(end) * outer
  const y1 = cy + Math.sin(end) * outer
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x0} ${y0} A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1} Z`
  }
  const xi0 = cx + Math.cos(end) * inner
  const yi0 = cy + Math.sin(end) * inner
  const xi1 = cx + Math.cos(start) * inner
  const yi1 = cy + Math.sin(start) * inner
  return [
    `M ${x0} ${y0}`,
    `A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1}`,
    `L ${xi0} ${yi0}`,
    `A ${inner} ${inner} 0 ${large} 0 ${xi1} ${yi1}`,
    'Z'
  ].join(' ')
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(2)
}
