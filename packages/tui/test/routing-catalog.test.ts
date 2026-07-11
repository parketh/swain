import { describe, expect, test } from "bun:test"
import { allCatalogModels, type RoutingProfile } from "../src/models"
import { catalogRoutableTargets, modelRoutableTargets } from "../src/router"

describe("routing catalog", () => {
  test("every non-deprecated catalog model exposes at least one routable target", () => {
    for (const model of allCatalogModels()) {
      expect(modelRoutableTargets(model).length).toBeGreaterThanOrEqual(1)
    }
  })

  test("every routable target has a routing profile with capability and avg cost", () => {
    for (const target of catalogRoutableTargets()) {
      expect(target.routing).toBeDefined()
      const r = target.routing as RoutingProfile
      expect(r.capability).toBeDefined()
      expect(r.avgCostPerTask).toBeDefined()
    }
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

  test("every catalog model exposes a reasoning-effort ladder", () => {
    for (const model of allCatalogModels()) {
      expect(model.variants.length).toBeGreaterThanOrEqual(2)
    }
  })
})
