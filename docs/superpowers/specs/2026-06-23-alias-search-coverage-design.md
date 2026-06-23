# Alias Search Coverage Design

## Goal

Ensure all user-facing name lookup modes use the same OpenSanctions-derived Senzing name source:

- `/check`
- `/basic`
- `/full`
- `/search`
- plain text fuzzy candidate search

The exact commands must match complete primary names and complete aliases. Fuzzy candidate search must also search partial input against both primary names and aliases.

## Existing Context

The bot loads `senzing.json` records into `SenzingMemoryRepository`. Each record exposes names through `NAMES[].NAME_FULL` with a `NAME_TYPE` such as `PRIMARY` or `ALIAS`.

Current repository behavior already builds two indexes from `NAMES[].NAME_FULL`:

- `nameIndex` powers exact lookup through `findByName`.
- `searchableNames` powers fuzzy candidate lookup through `findCandidateNames`.

`DebarmentService.check`, `basic`, and `full` all use the exact repository lookup. `DebarmentService.searchCandidates` uses the fuzzy repository lookup. The formatter already displays both the primary name and the matched name, so an alias match can be shown without changing response shape.

## Chosen Approach

Keep `NAMES[].NAME_FULL` as the single search-name source and lock the behavior with tests and documentation.

This means:

- Every non-empty `NAMES[].NAME_FULL` is indexed for exact lookup, regardless of `NAME_TYPE`.
- Every non-empty `NAMES[].NAME_FULL` is indexed for fuzzy candidate search, regardless of `NAME_TYPE`.
- Exact commands remain exact: partial aliases do not make `/check`, `/basic`, or `/full` return a Debarred result.
- Fuzzy search remains candidate-only: alias-based partial matches produce possible matches, not a Debarred verdict.

No separate alias search path is needed because the repository already treats primary names and aliases uniformly as searchable names.

## Rejected Alternatives

Adding service-level alias lookup was rejected because it would duplicate repository indexing logic and create two places where name matching could diverge.

Adding `targets.nested.json` names or parsing aliases from notes was rejected because the requested scope is limited to Senzing aliases. Expanding the source set would change data provenance and needs a separate design.

Changing `/check`, `/basic`, or `/full` to fuzzy search was rejected because these commands are used for exact Debarred determinations. Partial names should continue to go through `/search` or plain text candidate search.

## User Behavior

If the Senzing record has:

- Primary name: `YATAI SMART INDUSTRIAL NEW CITY`
- Alias: `MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO., LTD.`

Then:

- `/check MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO LTD` returns Debarred.
- `/basic MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO LTD` returns basic information.
- `/full MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO LTD` returns sanctions details.
- `/search Myanmar Yatai` returns the record as a possible match.
- Plain text `Myanmar Yatai` returns the same fuzzy candidate result.
- `/check Myanmar Yatai` still returns `No Data Found!` because it is only a partial alias.

For alias matches, result text should keep:

- `Name`: the primary name.
- `Matched Name`: the alias that matched the query.

## Components

### Repository

`SenzingMemoryRepository.addRecord` remains the source of truth for searchable names. It should continue to iterate all `record.NAMES`, trim each `NAME_FULL`, normalize it, deduplicate repeated normalized names per record, and add the match to both exact and fuzzy indexes.

### Service

`DebarmentService` continues to route exact commands through `queryByName` and fuzzy searches through `searchCandidateNames`. It should not add command-specific alias logic.

### Bot Handler

`BotCommandHandler` keeps the current command split:

- `/check`, `/basic`, and `/full` run exact lookup.
- `/search` and plain text run fuzzy candidate lookup unless a pending exact command is active.

No command parser changes are required.

### Formatting

Existing formatting should continue to show `Matched Name` when it differs from `Name`. This is enough to make alias hits understandable.

## Testing Plan

Add or strengthen Vitest coverage for:

- Exact service lookup matches a complete alias for `/check` behavior.
- `basic` and `full` also match complete aliases.
- Exact lookup does not match partial aliases.
- Fuzzy service lookup returns candidates for partial alias input.
- `/search <partial alias>` returns possible matches.
- Plain text partial alias input returns possible matches.
- Alias fuzzy search does not produce Debarred verdict language.

Existing tests for primary-name exact lookup, duplicate capping, non-debarment filtering, and callback details should remain unchanged.

## Documentation Plan

Update user-facing docs to say:

- `/check`, `/basic`, and `/full` require a complete primary name or complete alias.
- `/search` and plain text can use primary-name or alias partial input to find candidates.
- Exact lookup does not search addresses, identifiers, `targets.nested.json`, or note-derived aliases.

## Out of Scope

Do not add:

- New commands.
- New callback actions.
- New alias extraction from `targets.nested.json`.
- Note parsing for `(also ...)` aliases.
- Fuzzy Debarred verdicts for `/check`, `/basic`, or `/full`.
