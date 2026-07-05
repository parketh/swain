import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import { App } from "../src/app"

describe("App", () => {
  test("renders the shell with the working directory", () => {
    const { lastFrame } = render(<App cwd="/work" />)
    expect(lastFrame()).toContain("swain")
    expect(lastFrame()).toContain("/work")
  })
})
