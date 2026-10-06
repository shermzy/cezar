/*
 * Ported from BoardUI's Composer Loader — t3grp/boardui-pro,
 * components/application/composer-loader/composer-loader.tsx (and its `bui-composer-loader-*`
 * rules in styles/globals.css). Adapted for cezar: design-token colours, the card's own surface
 * token, a measured corner radius, and a static rim under reduced motion.
 *
 * MIT License
 *
 * Copyright (c) 2026 Mertcan Dundar Esmergul (BoardUI)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * A light band travelling around a running card's rim, with a soft bloom bleeding inward — the
 * Board's "this one is working" (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c → Running
 * animation). It replaces the pulsing dot on running cards.
 *
 * The band is dash segments on an SVG stroke of the card's rounded rect (`pathLength`-normalized,
 * so it travels at constant speed and bends around the corners), drawn three times — a wide bloom,
 * a tight glow and a crisp line — with the crisp line leading and each soft layer's head pulled
 * back behind the tip. The blur is SVG-native (`feGaussianBlur`), not CSS `filter`: WebKit ignores
 * CSS filters on individual SVG elements, which rendered the light razor-sharp on iPhones.
 *
 * The component paints the card SURFACE itself (`bg-card`) and layers the light above it, under
 * the content — so the wrapped card must not paint its own background, or it hides the light.
 * `active` fades the whole effect in and out over 450 ms. Under `prefers-reduced-motion` the band
 * is replaced by a static 1 px violet rim (`.running-beam-*` in `styles/index.css`).
 */

export interface RunningBeamProps {
  children: ReactNode
  /** Show the light. Fades in/out over 450 ms. */
  active?: boolean
  /** Four gradient colours, spread across the card left → right. CSS colours — design tokens. */
  colors?: [string, string, string, string]
  /** Seconds per full lap. */
  speed?: number
  /** Overall light opacity. */
  intensity?: number
  /** How far the bloom bleeds inward from the rim, px. */
  bloom?: number
  /** Bloom layer opacity. */
  bloomStrength?: number
  /** How much of the perimeter the band occupies, degrees (of 360). */
  arc?: number
  /** Reverse the travel direction. */
  reverse?: boolean
  /** Corner radius, px. Defaults to the wrapper's own computed radius (its `rounded-*` class). */
  radius?: number
  /** Width of the crisp line, px; the tight glow scales with it. */
  line?: number
  /** The wrapper's classes — its `rounded-*` is the radius the light follows. */
  className?: string
}

/** BoardUI's teal / sky / pink / mint, as cezar's nearest tokens. */
const TOKEN_COLORS: [string, string, string, string] = [
  'var(--success)',
  'var(--info)',
  'var(--violet)',
  'var(--accent-lime)',
]

export function RunningBeam({
  children,
  active = true,
  colors = TOKEN_COLORS,
  speed = 4.5,
  intensity = 0.7,
  bloom = 16,
  bloomStrength = 0.3,
  arc = 120,
  reverse = false,
  radius,
  line = 2.5,
  className,
}: RunningBeamProps) {
  const gradientId = `running-beam-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const clipRef = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState({ w: 240, h: 80, r: 10 })

  useEffect(() => {
    const el = clipRef.current
    if (!el) return
    const measure = () =>
      setBox({
        w: Math.max(1, el.clientWidth),
        h: Math.max(1, el.clientHeight),
        // `rounded-[inherit]` on the clip: this is the wrapper's token radius, in px.
        r: Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
      })
    measure()
    // jsdom has no ResizeObserver; the first measure is all a test render needs.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const [c0, c1, c2, c3] = colors
  // Gradient centre: an even blend of the middle colours, so the band never washes out to white.
  const mid = `color-mix(in srgb, ${c1} 50%, ${c2})`

  const band = (arc / 360) * 100
  const rx = radius ?? box.r
  const direction = reverse ? 'reverse' : 'normal'

  // Path units per px, for pulling each soft layer's head behind the tip. Rounded-rect perimeter:
  // straight runs plus the four corner arcs.
  const cornerR = Math.min(rx, box.w / 2, box.h / 2)
  const perimeter = Math.max(1, 2 * (box.w + box.h) - 8 * cornerR + 2 * Math.PI * cornerR)
  const pxUnits = (px: number) => (px * 100) / perimeter
  // A layer's delay is its phase: the larger the phase, the further BACK along the lap the band
  // sits (a negative delay is a head start).
  const dashPhase = (len: number, backPx: number) => (reverse ? pxUnits(backPx) : len - band + pxUnits(backPx))

  const CRISP_BLUR = 0.5
  const stroke = (width: number, blur: number, opacity: number, dashLen: number, backPx: number) => (
    <rect
      x={0}
      y={0}
      width={box.w}
      height={box.h}
      rx={rx}
      pathLength={100}
      fill="none"
      stroke={`url(#${gradientId})`}
      strokeWidth={width}
      strokeLinecap="round"
      strokeDasharray={`${dashLen} ${100 - dashLen}`}
      filter={blur > 0 ? `url(#${gradientId}-b${String(blur).replace('.', '_')})` : undefined}
      style={{
        opacity,
        animation: `running-beam-dash ${speed}s linear ${(dashPhase(dashLen, backPx) * speed) / 100}s infinite ${direction}`,
      }}
    />
  )

  /** One `feGaussianBlur` per blur radius the layers use, its region widened well past the stroke
   *  so the blur never clips at the filter bounds. */
  const blurFilter = (stdDeviation: number) => (
    <filter
      key={stdDeviation}
      id={`${gradientId}-b${String(stdDeviation).replace('.', '_')}`}
      x="-50%"
      y="-50%"
      width="200%"
      height="200%"
    >
      <feGaussianBlur stdDeviation={stdDeviation} />
    </filter>
  )

  return (
    <div data-slot="running-beam" data-active={active} className={cn('relative', className)}>
      <span aria-hidden="true" className="absolute inset-0 rounded-[inherit] bg-card" />
      <span
        ref={clipRef}
        aria-hidden="true"
        className="running-beam-light pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
        style={{ opacity: active ? 1 : 0, transition: 'opacity 450ms ease' }}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${box.w} ${box.h}`}
          preserveAspectRatio="none"
          style={{ opacity: intensity }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" style={{ stopColor: c0 }} />
              <stop offset="30%" style={{ stopColor: c1 }} />
              <stop offset="50%" style={{ stopColor: mid }} />
              <stop offset="70%" style={{ stopColor: c2 }} />
              <stop offset="100%" style={{ stopColor: c3 }} />
            </linearGradient>
            {[14, 6, CRISP_BLUR].map(blurFilter)}
          </defs>
          {/* wide bloom bleeding inward (the outer half is clipped by the card) */}
          {bloom > 0 ? stroke(bloom * 2, 14, bloomStrength, band * 0.9, bloom + 16) : null}
          {/* tight glow */}
          {stroke(line * 3.2, 6, 0.8, band * 0.95, 10)}
          {/* crisp line, tip leading */}
          {stroke(line, CRISP_BLUR, 1, band, 0)}
        </svg>
      </span>
      <div className="relative">{children}</div>
      {/* Reduced motion only: the band stops, so a still violet rim says "running" instead. */}
      <span
        aria-hidden="true"
        className="running-beam-rim pointer-events-none absolute inset-0 rounded-[inherit] border border-violet"
        style={{ opacity: active ? 1 : 0 }}
      />
    </div>
  )
}