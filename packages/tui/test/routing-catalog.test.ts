import { describe, expect, test } from "bun:test"
import type { TuiConfig } from "../src/config"
import { allCatalogModels, type RoutingProfile } from "../src/models"
import { catalogRoutableTargets, enabledRouterTargets, modelRoutableTargets } from "../src/router"

describe("routing catalog", () => {
  test("every non-deprecated catalog model exposes at least one routable target", () => {
    for (const model of allCatalogModels()) {
      expect(modelRoutableTargets(model).length).toBeGreaterThanOrEqual(1)
    }
  })

  test("a target's routing metrics are all-or-nothing, never partial", () => {
    for (const target of catalogRoutableTargets()) {
      const r = (target.routing ?? {}) as RoutingProfile
      // Either both metrics are present (real data) or neither (a "no data"
      // placeholder) — never one without the other.
      expect(r.capability !== undefined).toBe(r.avgCostPerTask !== undefined)
    }
  })

  test("router-enabled targets exclude models with no routing data", () => {
    const config: TuiConfig = {
      providers: { openai: { apiKey: "x" }, zai: { apiKey: "x" } },
      router: { enabled: true, disabledModels: [], disabledTargets: [] },
    }
    const enabled = enabledRouterTargets(config)
    expect(enabled.length).toBeGreaterThan(0)
    for (const target of enabled) {
      expect(target.routing?.capability).toBeDefined()
      expect(target.routing?.avgCostPerTask).toBeDefined()
    }
    const ids = enabled.map((t) => t.id)
    // The `p()` placeholders must not reach the router.
    expect(ids).not.toContain("openai:gpt-5.5-pro:high")
    expect(ids).not.toContain("zai:glm-5.2:high")
  })

  test("metadata stays within valid ranges", () => {
    for (const target of catalogRoutableTargets()) {
      const r = target.routing as RoutingProfile
      if (r.capability !== undefined) {
        expect(r.capability).toBeGreaterThanOrEqual(0)
        expect(r.capability).toBeLessThanOrEqual(100)
      }
      if (r.avgCostPerTask !== undefined) expect(r.avgCostPerTask).toBeGreaterThanOrEqual(0)
    }
  })

  test("every reasoning model exposes at least one real variant", () => {
    // Models expose a graded effort ladder or, like Kimi K3, a single fixed
    // effort — but never zero variants.
    for (const model of allCatalogModels()) {
      expect(model.variants.length).toBeGreaterThanOrEqual(1)
    }
  })

  test("Kimi K3 exposes exactly the max variant", () => {
    const k3 = allCatalogModels().find((m) => m.modelId === "kimi-k3")
    expect(k3).toBeDefined()
    expect(k3?.variants.map((v) => v.id)).toEqual(["max"])
  })

  test("the Kimi K3 target is router-enabled once Kimi is configured", () => {
    const config: TuiConfig = {
      providers: { kimi: { apiKey: "sk-kimi" } },
      router: { enabled: true, disabledModels: [], disabledTargets: [] },
    }
    const ids = enabledRouterTargets(config).map((t) => t.id)
    expect(ids).toContain("kimi:kimi-k3:max")
  })
})
