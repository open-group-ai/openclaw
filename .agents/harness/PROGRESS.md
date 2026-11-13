# PROGRESS — OpenClaw Controller / NSVX session harness

Course note: this file has the role of `claude-progress.md` in Learn Harness Engineering.

## Current Verified State

- Repository root: `open-group-ai/openclaw` (product contract: root `AGENTS.md`, under 20,000 characters)
- Standard startup path: `.agents/harness/AGENTS.md` → `.agents/harness/init.sh`
- Standard verification path: `.agents/harness/init.sh` (harness state, `pnpm check:agents-md-size`, nsvx entry test); focused suites per `docs/help/testing/suites.md`
- Product surface: OpenClaw Control desktop app → `nsvx` hub only (Miguel 2026-11-06 t45u–t48u). The old NSVX-themed icon-rail UI is retired.
- Highest-priority unfinished feature: see `feature_list.json`
- Current blocker: see `feature_list.json` notes
- Git checkpoint: `541fa1bec4f079c32406f4206630470f8ae57463` (PR #57 merge, origin/develop base for this session)

## Session Log

### Session 001 — 2026-11-06 (harness initializer)

- Goal: land the session kit under `.agents/harness/` and a one-line pointer in root `AGENTS.md`.
- Completed: kit files added; root `AGENTS.md` body unchanged except the pointer.
- Verification run: see `verification/NOTES.md`.
- Commits: initializer PR (merge sha recorded by the next session).
- Next best step: top non-passing feature in `feature_list.json`.

### Session 002 — 2026-11-06 (validate: histogram + no-early-victory)

- Goal: gap-fill `validate.mjs` — always print the diagnostic layer histogram from `diagnostics/log.jsonl`; fail closed on WIP>1, passing-without-evidence, blank evidence entries, and unreadable state files.
- Completed: `summarizeLayers`/`formatHistogram` exports; evidence tightening; graceful unreadable-file errors; committed `validate.test.mjs` (8 tests, node:test, zero deps).
- Verification run (in order, all green): unit `node --test` 8/8 → integration full `init.sh` exit 0 → e2e histogram from real log lines. See `verification/NOTES.md`.
- Baseline: first init run failed closed (missing `node_modules`); fixed via sanctioned `pnpm install` inside `init.sh`, logged as `execution_environment`.
- Next best step: `control-files-read-error` (priority 2, needs hub source location first).
