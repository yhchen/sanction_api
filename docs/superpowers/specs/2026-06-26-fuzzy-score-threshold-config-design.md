# Fuzzy Score Threshold Config Design

## Goal

Make the fuzzy candidate score threshold configurable from `.env`.

The bot should hide fuzzy search candidates whose score is below the configured threshold. If the environment variable is absent or blank, the default threshold is `0.8`.

This applies to fuzzy candidate search only:

- `/search <name>`
- plain text search when no pending command mode is active
- no-argument `/search` follow-up input

Exact lookup commands (`/check`, `/basic`, `/full`) remain unchanged.

## Existing Context

The current fuzzy search flow is:

1. `BotCommandHandler` calls `DebarmentService.searchCandidates`.
2. `DebarmentService.searchCandidateNames` asks `SenzingLookupRepository.findCandidateNames` for fuzzy candidates.
3. `SenzingMemoryRepository.findCandidateNames` computes candidate scores, filters by a module constant named `MIN_FUZZY_SCORE`, sorts candidates, and removes duplicate record/name pairs.
4. `DebarmentService` filters non-debarment records, deduplicates by record id, caps visible candidates, and reports `found`, `totalCandidates`, and `truncated`.
5. `formatFuzzySearchResult` renders only the returned candidates.

The current hard-coded repository threshold is `0.55`. The new default must be `0.8`.

Configuration is currently centralized in `src/config.ts` through `loadConfig()`, with existing numeric validation helpers for integer settings such as `MAX_RESULTS` and `MAX_MESSAGE_CHARS`.

## Chosen Approach

Add `MIN_FUZZY_SCORE` to application config and pass the parsed value into fuzzy candidate scoring.

Recommended shape:

```ts
interface AppConfig {
  // existing fields...
  minFuzzyScore: number;
}
```

`loadConfig()` should parse `env.MIN_FUZZY_SCORE` as a finite decimal number in the inclusive range `0` to `1`. Missing or blank values should return `0.8`.

`SenzingMemoryRepository` should receive the threshold as repository construction options. The repository should continue to own score calculation and candidate filtering, but the threshold should no longer be a fixed module constant. This keeps scoring and filtering together while keeping environment parsing outside the data layer.

The CLI/runtime startup path should pass `config.minFuzzyScore` into `SenzingMemoryRepository.fromFile(config.senzingPath, { minFuzzyScore: config.minFuzzyScore })`.

## Alternatives Considered

### Read `process.env.MIN_FUZZY_SCORE` inside `SenzingMemoryRepository`

This is the smallest code diff, but it gives the data layer hidden global configuration and makes tests more fragile. It also bypasses the existing `loadConfig()` validation pattern.

### Filter by score in `DebarmentService`

This avoids changing repository construction, but it separates score production from score thresholding. The repository would still sort and return candidates that the service later discards, and `totalCandidates` semantics would be easier to get wrong.

### Keep a hard-coded `0.8` constant

This satisfies the default threshold but not the `.env` requirement.

## Component Changes

### Config

Add `MIN_FUZZY_SCORE` parsing in `src/config.ts`.

Validation rules:

- Missing or blank: `0.8`
- Valid: any finite number from `0` through `1`, inclusive
- Invalid: throw a clear startup error, such as `MIN_FUZZY_SCORE must be a number between 0 and 1.`

Examples:

- `MIN_FUZZY_SCORE=0.8`
- `MIN_FUZZY_SCORE=0.75`
- `MIN_FUZZY_SCORE=1`

### Repository

Add a repository options type:

```ts
interface SenzingMemoryRepositoryOptions {
  minFuzzyScore?: number;
}
```

`SenzingMemoryRepository.fromFile` and `SenzingMemoryRepository.fromRecords` should accept these options and store a normalized threshold on the repository instance.

`scoreCandidate` should compare against the repository threshold instead of the current hard-coded `MIN_FUZZY_SCORE`.

Existing tests that instantiate stub repositories directly are unaffected. Tests that build a real `SenzingMemoryRepository` may pass a threshold when they need lower-score fixture matches.

### Startup and Refresh

The initial startup load should pass `config.minFuzzyScore` into `SenzingMemoryRepository.fromFile`.

Any code path that reloads Senzing data into an active repository during refresh must also use the same configured threshold. If `DataRefreshService` currently constructs a fresh `SenzingMemoryRepository`, its options should include the threshold from config.

This prevents a startup repository and a refreshed repository from using different fuzzy filtering behavior.

### Documentation

Update `.env.example` with:

```text
MIN_FUZZY_SCORE=0.8
```

Update README and operation docs where environment variables are listed. The description should say that fuzzy candidates below this score are hidden and that the default is `0.8`.

## Data Flow

1. Process starts.
2. `loadConfig()` parses `MIN_FUZZY_SCORE`, defaulting to `0.8`.
3. Startup and refresh repository construction receive `minFuzzyScore`.
4. `findCandidateNames()` calculates each fuzzy score.
5. Candidates below `minFuzzyScore` are discarded before sorting and de-duplication.
6. `DebarmentService` receives only threshold-qualified candidates.
7. `found`, `totalCandidates`, `truncated`, and rendered fuzzy output are all based on threshold-qualified candidates.

## Error Handling

- Invalid `MIN_FUZZY_SCORE` should fail fast during config loading.
- Empty or whitespace-only `MIN_FUZZY_SCORE` should behave like missing and use `0.8`.
- A threshold of `1` should allow exact-name fuzzy candidates only.
- A threshold of `0` should effectively disable score-threshold filtering while preserving all other fuzzy search filters.

## Testing Plan

Add or update Vitest coverage for:

- `loadConfig()` defaults `minFuzzyScore` to `0.8`.
- `loadConfig()` accepts decimal values such as `0.75`.
- `loadConfig()` rejects non-numeric, negative, and greater-than-1 values.
- `SenzingMemoryRepository.findCandidateNames()` hides candidates below the configured threshold.
- `SenzingMemoryRepository.findCandidateNames()` can still return lower-scoring fixture candidates when constructed with a lower threshold.
- Bot/service fuzzy search tests continue to pass under the new default by adjusting fixtures or test-specific repository options where needed.
- Data refresh uses the same threshold as startup when constructing refreshed repositories.

## Out of Scope

Do not change:

- The fuzzy score formula.
- Candidate sort order.
- Candidate cap defaults.
- Exact matching behavior.
- Telegram formatter wording except documentation-driven references to the new threshold.
- Access control or deep-link behavior.
