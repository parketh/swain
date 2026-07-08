import { describe, expect, test } from "bun:test"
import { isDark, mix, parseOsc11, shadeFor } from "../src/terminalBackground"

describe("parseOsc11", () => {
  test("parses a 16-bit-per-channel BEL-terminated reply", () => {
    expect(parseOsc11("\x1b]11;rgb:1e1e/1e1e/1e1e\x07")).toBe("#1e1e1e")
  })

  test("parses an ST-terminated reply", () => {
    expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toBe("#ffffff")
  })

  test("parses 8-bit components", () => {
    expect(parseOsc11("\x1b]11;rgb:12/34/56\x07")).toBe("#123456")
  })

  test("scales 4-bit components to 8-bit", () => {
    expect(parseOsc11("\x1b]11;rgb:f/0/8\x07")).toBe("#ff0088")
  })

  test("accepts rgba replies", () => {
    expect(parseOsc11("\x1b]11;rgba:1000/2000/3000/ffff\x07")).toBe("#102030")
  })

  test("returns undefined for unrelated or partial input", () => {
    expect(parseOsc11("")).toBeUndefined()
    expect(parseOsc11("\x1b]11;rgb:12")).toBeUndefined()
    expect(parseOsc11("hello")).toBeUndefined()
  })
})

describe("shading", () => {
  test("isDark distinguishes dark and light backgrounds", () => {
    expect(isDark("#1e1e1e")).toBe(true)
    expect(isDark("#ffffff")).toBe(false)
  })

  test("mix moves toward white or black", () => {
    expect(mix("#000000", 1)).toBe("#ffffff")
    expect(mix("#ffffff", -1)).toBe("#000000")
    expect(mix("#808080", 0)).toBe("#808080")
  })

  test("shadeFor lightens dark backgrounds and darkens light ones", () => {
    expect(shadeFor("#1e1e1e") > "#1e1e1e").toBe(true)
    expect(shadeFor("#ffffff") < "#ffffff").toBe(true)
  })
})
