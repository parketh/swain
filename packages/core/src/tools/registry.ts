import { Context, Layer } from "effect"
import type { AnyTool } from "./tool"

export class ToolRegistry extends Context.Tag("@swain/core/ToolRegistry")<
  ToolRegistry,
  ReadonlyMap<string, AnyTool>
>() {}

export const makeRegistry = (tools: ReadonlyArray<AnyTool>): ReadonlyMap<string, AnyTool> =>
  new Map(tools.map((tool) => [tool.name, tool]))

export const registryLayer = (tools: ReadonlyArray<AnyTool>): Layer.Layer<ToolRegistry> =>
  Layer.succeed(ToolRegistry, makeRegistry(tools))
