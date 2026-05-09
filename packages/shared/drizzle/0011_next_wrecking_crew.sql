-- Migration 0011 — `domains.disabled_at` for the soft-delete
-- lifecycle (phase-a appendix #10 PR-R1).
--
-- Adds a nullable timestamptz column flagging retired domains
-- (operator-issued DELETE without `?hard=1`). The default Domains
-- listing filters `disabled_at IS NULL`; the aggregator-uniqueness
-- pre-check also filters disabled rows so a retired aggregator does
-- not block a fresh one. Re-enabling is NOT in v0.1 scope — soft-
-- delete is a one-way valve in this release.
--
-- The composite index `(disabled_at, slug)` keeps the listing query
-- (filter on disabled_at, order by slug) fast even as the disabled
-- set grows over time. Pure ALTER+CREATE — no destructive ops.

ALTER TABLE "domains" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "domains_disabled_at_slug_idx" ON "domains" USING btree ("disabled_at","slug");
