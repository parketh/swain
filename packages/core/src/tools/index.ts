export {
  type AnyTool,
  callTool,
  defineTool,
  makeToolRegistry,
  type Tool,
  ToolContext,
  type ToolContextValue,
  ToolProgress,
  type ToolProgressValue,
  ToolRegistry,
  toLLMTool,
  toolRegistryLayer,
} from "../tool"
export {
  Ask,
  AskAnswer,
  type AskHandler,
  AskInput,
  AskOption,
  AskQuestion,
  AskResult,
  AskService,
} from "./ask"
export { Bash, BashInput, BashResult, isHardDenied, isRisky } from "./bash"
export { Edit, EditInput, EditResult } from "./edit"
export { Glob, GlobInput, GlobResult } from "./glob"
export { Grep, GrepInput, GrepResult } from "./grep"
export { Read, ReadInput, ReadResult } from "./read"
export { errorResult, successResult } from "./results"
export { WebFetch, WebFetchInput, WebFetchResult } from "./web-fetch"
export {
  ExaSearchProvider,
  exaSearch,
  makeWebSearch,
  type SearchProvider,
  WebSearch,
  WebSearchInput,
  WebSearchOutput,
  WebSearchResult,
} from "./web-search"
export { Write, WriteInput, WriteResult } from "./write"

import type { AnyTool } from "../tool"
import { Ask } from "./ask"
import { Bash } from "./bash"
import { Edit } from "./edit"
import { Glob } from "./glob"
import { Grep } from "./grep"
import { Read } from "./read"
import { WebFetch } from "./web-fetch"
import { WebSearch } from "./web-search"
import { Write } from "./write"

/** The default tool set wired by interactive runtimes (REPL, TUI). */
export const builtinTools: ReadonlyArray<AnyTool> = [
  Read,
  Write,
  Edit,
  Glob,
  Grep,
  Bash,
  WebSearch,
  WebFetch,
  Ask,
]
