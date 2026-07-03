import { Schema } from "effect"

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"))
export type ProviderId = typeof ProviderId.Type

export const ModelId = Schema.String.pipe(Schema.brand("ModelId"))
export type ModelId = typeof ModelId.Type

export const ProtocolId = Schema.String.pipe(Schema.brand("ProtocolId"))
export type ProtocolId = typeof ProtocolId.Type

export const ContentId = Schema.String.pipe(Schema.brand("ContentId"))
export type ContentId = typeof ContentId.Type

export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type
