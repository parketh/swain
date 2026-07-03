import { describe, expect, test } from "bun:test"

import * as root from "@swain/llms"
import * as schema from "@swain/llms/schema"
import * as providers from "@swain/llms/providers"
import * as protocols from "@swain/llms/protocols"
import * as transport from "@swain/llms/transport"

describe("public export paths", () => {
  test("all export paths resolve", () => {
    expect(root).toBeDefined()
    expect(schema).toBeDefined()
    expect(providers).toBeDefined()
    expect(protocols).toBeDefined()
    expect(transport).toBeDefined()
  })
})
