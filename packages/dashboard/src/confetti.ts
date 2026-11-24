/**
 * A burst of confetti over the whole window, for a moment worth celebrating (a bot just added).
 * Draws on a canvas laid over the page for a few seconds, then removes it; does nothing for people
 * who ask for reduced motion.
 */

const COLORS = ['#5B6CE0', '#2F9E77', '#F2B33D', '#E5577A', '#3B8FC4', '#8A63D2', '#F07C3C']

interface Piece {
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  spin: number
  width: number
  height: number
  color: string
  /** Pieces flutter: their width swings as they turn. */
  phase: number
  round: boolean
}

export function confetti(options: { count?: number; duration?: number } = {}) {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const count = options.count ?? 160
  const duration = options.duration ?? 3200
  const ratio = window.devicePixelRatio || 1
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '4000' })
  canvas.setAttribute('aria-hidden', 'true')
  const resize = () => {
    canvas.width = window.innerWidth * ratio
    canvas.height = window.innerHeight * ratio
  }
  resize()
  document.body.appendChild(canvas)
  const context = canvas.getContext('2d')
  if (!context) return canvas.remove()
  window.addEventListener('resize', resize)

  // Two cannons in the lower corners, aimed up and in.
  const pieces: Piece[] = Array.from({ length: count }, (_, index) => {
    const left = index % 2 === 0
    const angle = (left ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.7
    const speed = (14 + Math.random() * 12) * ratio
    return {
      x: (left ? 0.05 : 0.95) * canvas.width,
      y: canvas.height * 0.9,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      angle: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      width: (6 + Math.random() * 6) * ratio,
      height: (8 + Math.random() * 8) * ratio,
      color: COLORS[index % COLORS.length],
      phase: Math.random() * Math.PI * 2,
      round: Math.random() < 0.2,
    }
  })

  const start = performance.now()
  const frame = (now: number) => {
    const elapsed = now - start
    context.clearRect(0, 0, canvas.width, canvas.height)
    // Fade out over the last third.
    context.globalAlpha = Math.min(1, Math.max(0, (duration - elapsed) / (duration / 3)))
    for (const piece of pieces) {
      piece.vy += 0.35 * ratio
      piece.vx *= 0.985
      piece.vy *= 0.985
      piece.x += piece.vx
      piece.y += piece.vy
      piece.angle += piece.spin
      piece.phase += 0.12
      context.save()
      context.translate(piece.x, piece.y)
      context.rotate(piece.angle)
      context.fillStyle = piece.color
      const width = piece.width * Math.abs(Math.cos(piece.phase))
      if (piece.round) {
        context.beginPath()
        context.ellipse(0, 0, width / 2 + 1, piece.width / 2, 0, 0, Math.PI * 2)
        context.fill()
      } else {
        context.fillRect(-width / 2, -piece.height / 2, width, piece.height)
      }
      context.restore()
    }
    if (elapsed < duration) requestAnimationFrame(frame)
    else {
      window.removeEventListener('resize', resize)
      canvas.remove()
    }
  }
  requestAnimationFrame(frame)
}
