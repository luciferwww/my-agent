# Model Invocation Error Boundary Plan

> Status: Archived — completed and owner-accepted
> Role: Delivery provenance; not error-contract authority

This change introduced a constructor-independent, same-realm structural Model Invocation Error V1. Core owns protocol/category validation and Host canonicalization; separately emitted Relay code produces the structural shape without importing or subclassing the Host constructor.

Delivery covered strict own-data-property validation, unknown-version rejection, diagnostic allowlisting/freezing, bounded cycle-safe cause traversal, privacy checks, Relay producer migration, Runtime classification, emitted-artifact scans, tests, lint/build, and independent review.

The durable contract is [Model Invocation Errors](../../../specifications/model-invocation-errors.md). Abort and context overflow remain separate boundaries. Historical review narration and repeated command output are omitted.
