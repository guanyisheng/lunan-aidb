import { useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BarChart, parseChartBlock, PieOrDonutChart } from './charts'
import './markdown.css'

const CHART_LANGS = new Set(['pie', 'donut', 'doughnut', 'bar', 'chart'])

export function MarkdownView(props: {
  content: string
  className?: string
  /** When true, skip chart blocks and render as plain code (e.g. streaming). */
  plainCode?: boolean
}): ReactNode {
  const content = props.content ?? ''
  const components = useMemo((): Components => {
    return {
      // Fenced blocks: we own both pre+code so charts are not double-wrapped.
      pre({ children }) {
        return <>{children}</>
      },
      code({ className, children }) {
        const text = String(children ?? '').replace(/\n$/, '')
        const lang = (className?.match(/language-([\w-]+)/)?.[1] || '').toLowerCase()
        const fenced = Boolean(className?.includes('language-'))

        if (fenced && !props.plainCode && CHART_LANGS.has(lang)) {
          const parsed = parseChartBlock(text)
          if (parsed) {
            if (lang === 'bar') {
              return <BarChart title={parsed.title} data={parsed.data} />
            }
            if (lang === 'chart') {
              const kind = detectChartKind(text)
              if (kind === 'bar') return <BarChart title={parsed.title} data={parsed.data} />
              return <PieOrDonutChart title={parsed.title} data={parsed.data} donut={kind === 'donut'} />
            }
            const donut = lang === 'donut' || lang === 'doughnut'
            return <PieOrDonutChart title={parsed.title} data={parsed.data} donut={donut} />
          }
        }

        if (!fenced) {
          return <code className="md-inline-code">{text}</code>
        }
        return (
          <pre className="md-pre">
            <code className={className}>{text}</code>
          </pre>
        )
      },
      a({ href, children }) {
        const safeHref = href ?? ''
        const safe = /^https?:\/\//i.test(safeHref) || safeHref.startsWith('mailto:')
        if (!safe) return <span>{children}</span>
        return (
          <a href={safeHref} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        )
      },
      table({ children }) {
        return (
          <div className="md-table-wrap">
            <table>{children}</table>
          </div>
        )
      }
    }
  }, [props.plainCode])

  if (!content.trim()) return null

  return (
    <div className={`md-view ${props.className ?? ''}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

function detectChartKind(raw: string): 'pie' | 'donut' | 'bar' {
  const head = raw.slice(0, 120).toLowerCase()
  if (/"type"\s*:\s*"bar"/.test(head) || /type\s*[:：]\s*bar/.test(head)) return 'bar'
  if (/"type"\s*:\s*"donut"/.test(head) || /type\s*[:：]\s*donut/.test(head)) return 'donut'
  return 'pie'
}
