# Stable Specifications

> Status: Stable Specification Authority
> Authority: Long-lived behavioral and structural contracts

These documents define durable contracts that must remain true across implementation changes. They complement [Current Architecture](../architecture/README.md), which records verified implementation facts, and [Decisions](../decisions/README.md), which records accepted architectural choices.

## Interaction and transport

- [Approval Lifecycle](approval-lifecycle.md)
- [Attachments Support](attachments-support.md)
- [Channel](channel.md)
- [Multi-client User Messages](multi-client-user-messages.md)

## Execution and delegation

- [Abort](abort.md)
- [Runner Turn Flow](runner-turn-flow.md)
- [Subagent](subagent.md)
- [Subagent Model Resolution](subagent-model-resolution.md)
- [Tools and Hooks](tools-and-hooks.md)

## Host, configuration, and composition

- [Configuration](configuration.md)
- [Extension Acquisition](extension-acquisition.md)
- [Runtime Composition](runtime-composition.md)
- [Standalone Service Host](standalone-service-host.md)

## Model boundaries

- [Model Invocation Errors](model-invocation-errors.md)
- [Model Resolution](model-resolution.md)

Active Changes may propose amendments but do not silently override these contracts. Current code and tests remain validation evidence rather than a second specification authority.
