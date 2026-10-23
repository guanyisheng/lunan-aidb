import { useId, type ReactNode } from 'react'

/** AIDB Studio brand mark — soft four-point star with blue→violet→cyan gradient. */
export function AiStar(props: {
  size?: number
  className?: string
  thinking?: boolean
  title?: string
}): ReactNode {
  const size = props.size ?? 20
  const gradId = useId().replace(/:/g, '')
  return (
    <span
      className={`ai-star ${props.thinking ? 'thinking' : ''} ${props.className ?? ''}`}
      style={{ fontSize: size }}
      title={props.title}
      aria-hidden={props.title ? undefined : true}
      role={props.title ? 'img' : undefined}
    >
      <svg viewBox="0 0 32 32" className="star-glow">
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4F8CFF" />
            <stop offset="52%" stopColor="#8B7CFF" />
            <stop offset="100%" stopColor="#63D6FF" />
          </linearGradient>
        </defs>
        <path
          fill={`url(#${gradId})`}
          d="M16 2.2c.55 0 1 2.95 2.35 5.55C19.7 10.35 22.4 13 25.2 14.35 27.8 15.7 30.8 16.15 30.8 16.7c0 .55-2.95 1-5.55 2.35C22.45 20.4 19.8 23.1 18.45 25.9 17.1 28.5 16.65 31.5 16.1 31.5c-.55 0-1-2.95-2.35-5.55C12.4 23.15 9.7 20.5 6.9 19.15 4.3 17.8 1.3 17.35 1.3 16.8c0-.55 2.95-1 5.55-2.35C9.65 12.9 12.3 10.2 13.65 7.4 15 4.8 15.45 2.2 16 2.2z"
        />
      </svg>
    </span>
  )
}
