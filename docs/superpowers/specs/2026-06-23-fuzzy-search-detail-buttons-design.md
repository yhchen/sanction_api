# Fuzzy Search Detail Buttons Design

## Goal

Add per-candidate detail actions to fuzzy search results in the Telegram debarment lookup bot. A user who runs `/search <name>` or sends plain text should be able to tap `/basic N` or `/full N` for each returned candidate instead of copying the complete name into a separate command.

## Existing Context

The project already has:

- Fuzzy candidate search through `DebarmentService.searchCandidates`.
- Text formatting for fuzzy results in `formatFuzzySearchResult`.
- Inline buttons for exact lookup results through `actionButtons`.
- Callback handling for `basic:<recordId>` and `full:<recordId>`.
- Record-id lookup methods: `basicByRecordId` and `fullByRecordId`.

The implementation should reuse the existing callback and record-id detail path. Fuzzy search must continue to avoid Debarred verdict language because candidates are suggestions, not exact sanctions determinations.

## Chosen Approach

Return inline buttons from `formatFuzzySearchResult`, one row per candidate:

```text
/basic 1    /full 1
/basic 2    /full 2
```

Each button uses the candidate record id:

- `/basic N` sends `basic:<recordId>`.
- `/full N` sends `full:<recordId>`.

This matches the existing exact-result interaction model and avoids adding a new command, query parser branch, or callback action.

Rejected alternatives:

- Add text-only command suggestions such as `/basic <full name>` and `/full <full name>`, because long names are hard to copy and can be ambiguous.
- Add only a single `detail` button, because users asked for both basic and full detail access and the bot already supports both detail levels.

## User Flow

1. User sends `/search Yatai Smart` or plain text `Yatai Smart`.
2. Bot returns the current fuzzy candidate text, including the warning that candidates are not a Debarred verdict.
3. For each visible candidate, bot includes an inline button row:
   - `/basic 1`
   - `/full 1`
4. User taps `/basic 1`.
5. Bot handles the existing `basic:<recordId>` callback and returns basic record information for that candidate.
6. User taps `/full 1`.
7. Bot handles the existing `full:<recordId>` callback and returns full sanctions details for that candidate.

## Components

### Formatter

Update `formatFuzzySearchResult` so it returns buttons when candidates are present.

The candidate text remains focused on candidate ranking:

- Candidate number.
- Primary name.
- Matched name when different.
- Record ID.
- Fuzzy score and match reason.

The buttons provide the detail actions. This keeps the text readable and lets Telegram carry the interaction affordance.

### Callback Handling

No new callback action is needed. `BotCommandHandler.handleCallback` already accepts:

- `basic:<recordId>`
- `full:<recordId>`

`createBot` already routes these actions through `bot.action(/^(basic|full):(.+)$/u, ...)`.

### Service

No service change is needed. Fuzzy candidates already include `basic.recordId`, and the service already supports detail lookup by record id.

## Error Handling

- If fuzzy search finds no candidates, keep the current no-candidate text and return no buttons.
- If a candidate record id later cannot be resolved, keep the existing callback behavior: the record-id lookup returns `No Data Found!`.
- If output text is truncated by message length limits, the buttons still point to the visible capped candidate list because they are based on `result.candidates`, not on the raw total candidate count.

## Testing Plan

Update Vitest coverage for:

- Fuzzy search formatter returns one button row per candidate.
- Each candidate row contains `/basic N` and `/full N`.
- Button callback data uses `basic:<recordId>` and `full:<recordId>`.
- Fuzzy misses still return no buttons.
- Plain text fuzzy search returns detail buttons.
- Tapping a fuzzy candidate `/basic` callback returns basic information.
- Tapping a fuzzy candidate `/full` callback returns sanctions details.
- Existing fuzzy text still does not start with Debarred verdict language.

## Out of Scope

Do not add:

- A new `/detail` command.
- A new `detail:<recordId>` callback action.
- External OpenSanctions hyperlinks beyond the existing `OpenSanctions URL` in basic information.
- Changes to fuzzy ranking, candidate capping, exact matching, or access control.
