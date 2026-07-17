import { describe, expect, test } from "bun:test"
import { defaultTokenCounter } from "../src/context"

describe("defaultTokenCounter.estimateJson", () => {
  test("returns 0 for undefined instead of throwing", () => {
    expect(defaultTokenCounter.estimateJson(undefined)).toBe(0)
  })

  test("estimates serializable values by JSON length", () => {
    expect(defaultTokenCounter.estimateJson({ a: 1 })).toBeGreaterThan(0)
  })
})
