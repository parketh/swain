import { describe, expect, test } from "bun:test"
import { aggregateRouting, allCatalogModels, type RoutingProfile } from "../src/models"
import { catalogRoutableTargets, modelRoutableTargets } from "../src/router"

describe("routing catalog", () => {
  test("every non-deprecated catalog model exposes at least one routable target", () => {
    for (const model of allCatalogModels()) {
      expect(modelRoutableTargets(model).length).toBeGreaterThanOrEqual(1)
    }
  })

  test("every routable target has an explicit routing profile", () => {
    for (const target of catalogRoutableTargets()) {
      expect(target.routing).toBeDefined()
      // benchmarks is always present (empty = explicit unknown), never invented.
      expect(Array.isArray(target.routing?.benchmarks)).toBe(true)
    }
  })

  test("metadata stays within valid ranges", () => {
    for (const target of catalogRoutableTargets()) {
      const r = target.routing as RoutingProfile
      if (r.capability !== undefined) {
        expect(r.capability).toBeGreaterThanOrEqual(0)
        expect(r.capability).toBeLessThanOrEqual(100)
      }
      if (r.relCostEstimate !== undefined) {
        expect(r.relCostEstimate).toBeGreaterThan(0)
        expect(r.relCostBasis).toBeDefined()
      }
      if (r.contextWindow !== undefined) expect(r.contextWindow).toBeGreaterThan(0)
      if (r.inputCostPerMTok !== undefined) expect(r.inputCostPerMTok).toBeGreaterThanOrEqual(0)
      if (r.outputCostPerMTok !== undefined) expect(r.outputCostPerMTok).toBeGreaterThanOrEqual(0)
    }
  })

  test("effort variants of the same model can carry distinct relCostEstimate", () => {
    const opus = allCatalogModels().find((m) => m.modelId === "claude-opus-4-8")
    const estimates = (opus?.variants ?? []).map((v) => v.routing?.relCostEstimate)
    expect(new Set(estimates).size).toBeGreaterThan(1)
  })

  test("every catalog model exposes a reasoning-effort ladder", () => {
    for (const model of allCatalogModels()) {
      expect(model.variants.length).toBeGreaterThanOrEqual(2)
    }
  })
})

describe("aggregateRouting", () => {
  test("benchmarkAvg is the mean of benchmark scores", () => {
    const agg = aggregateRouting({
      benchmarks: [
        { name: "a", score: 80 },
        { name: "b", score: 60 },
      ],
    })
    expect(agg.benchmarkAvg).toBe(70)
  })

  test("aggregateCost is relCostEstimate × blended token cost", () => {
    const profile: RoutingProfile = {
      inputCostPerMTok: 5,
      outputCostPerMTok: 25,
      relCostEstimate: 2,
      benchmarks: [],
    }
    // (5 * 4 + 25) * 2 = 90
    expect(aggregateRouting(profile).aggregateCost).toBe(90)
  })

  test("missing inputs surface as explicit unknown, not zero", () => {
    const agg = aggregateRouting({ relCostEstimate: 2, benchmarks: [] })
    expect(agg.aggregateCost).toBeUndefined()
    expect(agg.benchmarkAvg).toBeUndefined()
  })
})
