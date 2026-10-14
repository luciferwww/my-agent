# Restart-stable Child Session Retention Specification

> Status: Accepted
> Date: 2026-10-13
> Owner: Project owner
> Plan: [Restart-stable Child Session Retention Plan](plan.md)

## 1. Store contract

The existing `sessions.json` remains the single Session metadata Store. It
contains:

- ordinary Chat entries in their existing public shape;
- Subagent entries with `kind: "subagent"`, Child identity, caller identity,
  creation/update timestamps, and optional terminal retention metadata.

Subagent Store metadata is internal persistence state. It does not add Child
entries to `listSessions()` or grant Chat management capabilities.

The Store has no version field. Migrating older `sessions.json` files is
outside this Change.

## 2. Child registration

A preparing Child remains memory-only because no Transcript exists yet.

After Child Transcript creation succeeds, SessionManager atomically adds:

```ts
{
  kind: "subagent",
  sessionId,
  callerSessionId,
  createdAt,
  updatedAt
}
```

If Store registration fails, Transcript creation fails and its new file is
removed. A Child is never advertised as active with only one durable half.

## 3. Terminal retention

When Child execution reaches a terminal outcome, SessionManager persists:

```ts
{
  completedAt,
  expiresAt: completedAt + 24 hours,
  outcome
}
```

The expiration is absolute. Reads and Runtime restarts do not extend it.

Graceful SessionManager close cancels in-process timers but does not remove
retained Child Store entries or Transcript files.

## 4. Startup recovery

Initialization reconciles the Store with Session Transcript files.

- An unexpired terminal Child is restored to the in-memory observation index
  and receives a timer for `expiresAt - now`.
- An expired Child is removed from the Store and its Transcript is deleted.
- A Child Store entry whose Transcript is missing is removed.
- A Child with a Transcript but no terminal metadata represents execution
  interrupted by the prior Runtime. Startup persists:

```ts
{
  completedAt: startupTime,
  expiresAt: startupTime + 24 hours,
  outcome: "interrupted"
}
```

  The partial Transcript remains read-only and addressable for that period.
- An unindexed Transcript remains an orphan and follows the existing deletion
  rule. This Change does not infer or import legacy Child identity from file
  contents.

Restart recovery never resumes execution or publishes synthetic live events.

## 5. Deletion

TTL and explicit Child deletion remove:

- the Transcript file;
- the Child Store entry;
- the in-memory observation entry;
- the in-process retention timer.

Deletion failure is reported through the existing warning/error paths and must
not produce a success-shaped observable Child.

## 6. Chat isolation

The following remain Chat-only:

- `getPersistedSession`;
- `listSessions`;
- rename;
- archive and unarchive;
- delete;
- fork;
- permission ownership outside this Change.

Passing a Child ID to a Chat management operation returns the existing
not-found behavior. `resolveSession` and History continue to observe both Chat
and Subagent kinds.

## 7. Acceptance scenarios

1. Child Transcript creation produces a typed Store entry.
2. Child completion persists one absolute expiration.
3. Graceful close and a new SessionManager initialization preserve an
   unexpired Child and its History.
4. Restart does not move a terminal Child's expiration.
5. Startup marks a nonterminal Child interrupted and retains it for 24 hours.
6. Startup removes expired and missing-file Child entries.
7. Explicit deletion removes Store, file, timer, and observation state.
8. Chat listing and every Chat lifecycle operation exclude Child entries.
