import { ExaSearchProvider } from "./exa"
import { makeWebSearch } from "./tool"

export { ExaSearchProvider, exaSearch } from "./exa"
export {
  makeWebSearch,
  type SearchProvider,
  WebSearchInput,
  WebSearchOutput,
  WebSearchResult,
} from "./tool"

/** Default `WebSearch` tool backed by Exa. */
export const WebSearch = makeWebSearch(ExaSearchProvider)
