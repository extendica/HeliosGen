# Persona Studio — first implementation

The `/studio` route adds an independent production desk. Existing gallery, canvas,
upload fixes, model adapters and account settings are unchanged.

## Included

- Saved Day 1 avatar references and performance directions.
- Projects with outfit references, editable look prompts and GPT Image 2,
  Seedream 5 Lite/Pro, Nano Banana 2/Pro via existing Kie adapters.
- Approval of a generated look or upload of an already finished first frame.
- Pasted scripts / Gemini breakdowns; optional text-only Gemini scene drafting
  through the existing assistant endpoint. The director does **not** inspect images.
- Editable scene dialogue, motion, duration and separate CapCut notes.
- Approval-gated Kling 3.0 jobs: every scene uses the same approved first frame.
- Separate take records containing immutable generation payloads.
- Request-ID reservation before paid submission; a replay does not resubmit.
- Explicit handling of uncertain submissions. These are not automatically retried.
- Review and select a take per scene; download selected clips in numbered ZIP order.
- Explicit server-side saves, revision checks for conflicting tabs, draft JSON export.

## Deployment gate

### Verified status — 2026-09-01

- The additive Studio migration was applied successfully to the existing
  HeliosGen Supabase project.
  The live website's public JavaScript confirms that project URL.
- Both new tables are empty, have RLS enabled, and deny `SELECT`/`INSERT` to
  `anon` and `authenticated`. The server role has the required access.
- Existing tables and records were not modified by this migration.
- 24 automated tests pass, including mocked cloud user scoping, stale-save
  rejection, per-user request reservations and unauthenticated route rejection.
  These are not live, signed-in end-to-end tests.
- The application branch remains unmerged and is not live. Studio browser
  acceptance and authenticated Studio end-to-end checks remain release gates.

### Paid adapter smoke tests — 2026-09-01

With explicit user approval, two jobs were submitted through the existing live
HeliosGen gallery, using its normal signed-in Kie connection:

| Test | Result |
| --- | --- |
| Nano Banana 2, 1K, 9:16, neutral green mug scene | Done; image saved in Supabase and present after reload |
| Kling 3.0, standard/720p, 5 seconds, 9:16, sound enabled | Done; video loads after reload, reported duration 5.041667 seconds |

The video used the generated image as its start frame. Database records confirm
the exact settings, successful status and no reported provider errors. Spending
remained within the approved test budget. No retries or additional paid jobs
were submitted. Account balances, task identifiers and asset URLs are deliberately
excluded from this public report.

These checks exercise the existing adapters, not the undeployed Studio UI, ZIP
export or Studio job wrapper. The neutral scene does not test avatar identity,
lip-sync or voice continuity; sound was enabled but audio quality was not reviewed.
The video record still references `tempfile.aiquickdraw.com`, not owned storage.
Durable video retention remains a release concern even though reload works today.

Supabase reports informational "RLS Enabled No Policy" notices for the Studio
tables. This is intentional: browser roles have no table privileges, and only
user-scoped server routes access them. Existing warnings for the unrelated
`touch_updated_at` function and disabled leaked-password protection were observed
but not changed as part of Studio. See Supabase's
[function search-path guidance](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)
and [password protection guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

### Setup for other installations

This branch is not a production deployment. Apply `supabase-studio.sql` through an
authorized Supabase migration connection before making Studio available in cloud
mode. It creates two new RLS-enabled, service-role-only tables. It does not alter
existing data. The application resolves the signed-in user before every Studio read,
write and generation request and scopes queries to that user.

Guest mode uses `data/studio.json` with an atomic rename and compare-and-swap in a
single server process. Guest mode is for a trusted, single-user installation only;
it does not provide multi-user authentication or multi-process locking.

Use existing Kie account settings and `CALLBACK_BASE_URL`. Uploaded references must
use the application's configured storage origin (or `/generated/` in guest mode).
No new environment variables or API keys are introduced.

## Tests

```
npx tsc --noEmit
npx eslint app/studio/page.tsx app/api/studio lib/studio.ts lib/studioStorage.ts
node --test tests/studio.test.mjs tests/storage.test.mjs
```

`tests/studio-browser.mjs` starts a guest-mode development server and runs a mocked
Playwright acceptance flow. It requires Playwright and its Chromium browser in the
test environment. It mocks all paid requests and creates screenshots under
`/tmp/helios-studio-qa/`. It never needs production credentials.

## Deliberately not in this release

- Automatic video ingestion / Gemini video analysis, keyframe selection and Shop flow.
- Voice-reference integration or a guarantee of consistent synthesized voices.
- AI inspection of generated looks, automatic outfit descriptions, or factual verification.
- Background batch scheduling: the browser submits approved jobs sequentially; already
  submitted jobs render independently after navigation. Unsubmitted scenes stay unstarted.
- Cancellation of provider jobs or automatic retries after uncertain outcomes.
- Batch cost quotes. Submission requires confirmation but currently uses the provider's
  configured pricing; do not present an invented estimate.
- Cross-tab deduplication of independently created requests. Request-ID replays are
  protected, but users should not launch the same batch from multiple tabs.

If a process fails after a provider accepts a job but before its task ID is saved,
the take remains `submitting`/`unknown`. Check provider logs and reconcile before
submitting another take; never assume no charge occurred. A reconciliation UI is
planned separately.

## Next validation

Before merging: verify cloud migration and authenticated user isolation against a
staging database; run one explicitly approved paid image and video generation,
check callback persistence and refresh recovery, then review voice and clothing
continuity. The code's mocked tests do not establish model output quality.
