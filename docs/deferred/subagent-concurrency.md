# Deferred Subagent Concurrency

> Status: Deferred alternative — frozen and non-authorizing
> Owner: Project owner
> Activation: A future accepted Plan/Specification must explicitly supersede this input

## Retained option

The historical v2 input explored same-Turn parallel execution of sibling `task` Tool Calls under bounded limits such as maximum concurrent Children and maximum sibling parallelism, while preserving blocking fan-in before the Parent Model continues.

Any successor must define deterministic result ordering, failure/Abort aggregation, per-Child isolation, Parent generation/signal inheritance, Tool Result closure, lifecycle events, rate/concurrency limits, cleanup, and bounded Shutdown. It must reconcile the existing rule that Provider Tool Calls execute sequentially.

## Explicit exclusions

This input does not authorize current implementation, detached/background work, cross-Turn jobs, nested expansion, shared mutable Session state, model-invocation rate-limit redesign, teams/handoffs, or arbitrary parallel Tools. Its historical filename did not make it an accepted Specification.

Current behavior is the blocking contract in [Subagent](../specifications/subagent.md). Activation follows [Development Workflow](../governance/development-workflow.md).
