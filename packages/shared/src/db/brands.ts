declare const brand: unique symbol;

export type Branded<T, B extends string> = T & {
  readonly [brand]: B;
};

export type DomainId = Branded<string, "DomainId">;
export type DomainSlug = Branded<string, "DomainSlug">;
export type SourceBindingId = Branded<string, "SourceBindingId">;
export type UserId = Branded<string, "UserId">;
export type CredentialId = Branded<string, "CredentialId">;

// --- ingestion-side branded IDs (PR 03) ---

export type IngestionIntakeId = Branded<string, "IngestionIntakeId">;
export type WebhookEventId = Branded<string, "WebhookEventId">;
export type PageCitationId = Branded<string, "PageCitationId">;
export type LlmUsageId = Branded<string, "LlmUsageId">;
export type LlmUsageDebugId = Branded<string, "LlmUsageDebugId">;
export type MinerRunId = Branded<string, "MinerRunId">;
export type CatalogCandidateId = Branded<string, "CatalogCandidateId">;
export type MinerSuppressionId = Branded<string, "MinerSuppressionId">;
export type RedactionEventId = Branded<string, "RedactionEventId">;
export type ErasureLogId = Branded<string, "ErasureLogId">;

// --- self-op branded IDs (PR 04) ---

export type AgentDefinitionId = Branded<string, "AgentDefinitionId">;
export type AgentInstanceId = Branded<string, "AgentInstanceId">;
export type AgentRunId = Branded<string, "AgentRunId">;
export type AutomationCandidateId = Branded<string, "AutomationCandidateId">;
export type AutomationDeploymentId = Branded<string, "AutomationDeploymentId">;
export type MarketplaceUpdateId = Branded<string, "MarketplaceUpdateId">;
