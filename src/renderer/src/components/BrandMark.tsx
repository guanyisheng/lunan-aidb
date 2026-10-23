import type { ReactNode } from 'react'
import logoUrl from '../assets/logo.png'

/** App logo (Lunan AIDB mascot). */
export function BrandMark(props: {
  size?: number
  className?: string
  title?: string
}): ReactNode {
  const size = props.size ?? 22
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt={props.title ?? 'Lunan AIDB'}
      title={props.title ?? 'Lunan AIDB'}
      className={`brand-logo ${props.className ?? ''}`}
      draggable={false}
      style={{ width: size, height: size, objectFit: 'contain', borderRadius: Math.max(4, Math.round(size * 0.18)) }}
    />
  )
}
