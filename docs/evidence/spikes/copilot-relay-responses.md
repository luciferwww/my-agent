# Copilot Relay Responses Protocol Spike Evidence

> Status: Completed — provisional pass accepted
> Executed: 2026-09-10
> Environment: Windows NT 10.0.26200.0; Node 22.22.2; loopback Relay at 127.0.0.1:5000; model `gpt-5.6-sol`
> Authority: Evidence only

## Method

The spike used raw HTTP and a bounded SSE parser against a local Relay. It queried `/v1/models`, selected one advertised HTTP `/responses` model, and exercised text, Tool round-trip, image input, Usage, Abort, and error scenarios. No SDK dependency was installed or evaluated.

## Observations

- Model discovery returned an eligible model.
- Non-stream and SSE text completed with a single terminal outcome and usable accounting.
- Tool name/call ID/arguments were reconstructed from stream deltas; follow-up sent stateless replay plus correlated Tool output.
- Relay item IDs were not treated as durable cross-request correlation keys.
- One image request was accepted in the bounded scenario.
- Pre-content and mid-stream Abort canceled without a false success terminal.
- Error category/status/message could be mapped; request ID was optional rather than guaranteed.

## Limits

The run did not establish broad Relay compatibility, SDK behavior, multiple-image limits, parallel Tool Calls, reasoning policy, structured output, or production delivery authority. Raw fetch was an evidence choice, not a universal protocol mandate.

Current implementation facts: [Providers](../../architecture/providers.md). Stable identity/Catalog contract: [Model Resolution](../../specifications/model-resolution.md). Delivery and C4 acceptance history: [archived Change](../../changes/archive/provider-model-catalog/plan.md).
