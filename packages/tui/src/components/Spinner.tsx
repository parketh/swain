import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import { theme } from "../theme"

// Claude Code's spinner glyph cycle: brightening then dimming.
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]

const VERBS = [
  "Brewing",
  "Churning",
  "Cooking",
  "Crunching",
  "Simmering",
  "Percolating",
  "Noodling",
  "Conjuring",
  "Wrangling",
  "Marinating",
  "Cogitating",
  "Concocting",
]

/**
 * Animated working indicator shown while a turn is in flight: a cycling glyph,
 * a whimsical verb (fixed per turn), and elapsed seconds. Replaces streaming
 * reasoning text, which is hidden.
 */
export const Spinner = () => {
  const [tick, setTick] = useState(0)
  const [start] = useState(() => Date.now())
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 120)
    return () => clearInterval(id)
  }, [])

  const glyph = FRAMES[tick % FRAMES.length]
  const elapsed = Math.floor((Date.now() - start) / 1000)

  return (
    <Box>
      <Text color={theme.primary}>{glyph} </Text>
      <Text color={theme.muted}>
        {verb}…{elapsed > 0 ? ` (${elapsed}s · esc to interrupt)` : " (esc to interrupt)"}
      </Text>
    </Box>
  )
}
