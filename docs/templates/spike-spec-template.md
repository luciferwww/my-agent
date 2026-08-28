# Spike Spec: Experiment Title

## Status

- **Status:** Draft
- **Date:** YYYY-MM-DD
- **Owner:**
- **Timebox:**
- **Related Plan / ADR / Spec:**

Follow the approval and evidence rules in the [Development Workflow](../development-workflow.md). Remove template guidance before acceptance.

## Question

State the single architecture or behavior question this Spike must answer.

## Hypothesis

Write a falsifiable prediction. Avoid describing the desired implementation as if it were evidence.

## Decision Unlocked

Name the ADR, Spec, boundary, or migration choice that depends on this result.

## Scope

- Minimal experiment needed to test the hypothesis

## Non-goals

- Production hardening or unrelated exploration

## Method

Describe setup, inputs, versions, steps, and how observations will be captured. Use Fakes and deterministic fixtures unless a real integration is necessary to answer the question.

## Required Evidence

- Commands, tests, traces, provider responses, or measurements to retain
- Environment and dependency versions to record

## Success Conditions

- Observable result that supports the hypothesis

## Failure and Stop Conditions

- Observable result that falsifies the hypothesis
- Condition that ends the experiment before the timebox

## Constraints

Document cost, secrets, network, cleanup, and safety constraints.

## Outputs

- Spike Results document
- ADR or Spec updates enabled by the result
- Disposable code and resource cleanup
