# Changes from the upstream brainstorming skill

Source: superpowers `skills/brainstorming/` (see ATTRIBUTION.md). Every edit made for sfactory:

## Files

- `SKILL.md` — adapted (below).
- `visual-companion.md` — dropped: the visual companion section is removed.
- `scripts/` (`frame-template.html`, `helper.js`, `server.cjs`, `start-server.sh`, `stop-server.sh`) — dropped: they served only the visual companion.
- `spec-document-reviewer-prompt.md` — dropped: the upstream SKILL.md no longer references it (its spec review is the inline self-review), and the factory's review of the brief is the person's, at the card's `awaiting-approval` stop.

## SKILL.md

1. Frontmatter `description`: rewritten to say the skill is the sfactory planning stage's first part, used by the orchestrator, so it does not trigger on any creative request in a session.
2. Opening: "user" became "the person"; a new **Where this runs** paragraph names what the orchestrator hands over (JOB, kind, title, JOB_DIR, the record paths with `{id}`, `{n}`, `{slug}` filled).
3. HARD-GATE: "the user has approved it" became "the person has agreed to it"; added that code is written only in `building`, after the approval gate.
4. Checklist: the visual-companion item removed; a **Stories first** item added (2); "Write design doc … save to the specs folder and commit" became "Write the brief to the card's `record.brief` path and commit it with `sfactory commit`"; "Spec self-review" became "Brief self-review"; "User reviews written spec" replaced by **Open questions** (a milestone's open questions go to `plan/questionnaire.md`); the transition names `sfactory:writing-plans`.
5. Process flow graph: the stories node, the questionnaire branch and the `record.brief` + `sfactory commit` node added; "User reviews spec?" removed (that review is the approval stop); the terminal node is `sfactory:writing-plans`.
6. New section **Stories First**: when `record.stories` is set, read the covering stories before the first question; with none, write the stories first and commit them through `sfactory commit`; skipped when unset.
7. The Process: decomposition makes further pieces separate cards (`/sfactory add milestone`); a bullet added under "Design for isolation" on disjoint files enabling parallel tasks.
8. After the Design: the design doc goes to `record.brief` (the project's brief path for the card), never the upstream specs folder; done-whens required (the judge reads them); the commit step became `sfactory commit --cwd <checkout> --holder <JOB> --m "…" -- <record.brief>`, never `git commit`, `git add -A` or `git add .`.
9. Spec Self-Review renamed Brief Self-Review; the consistency check adds the stories; the ambiguity check may turn into a question for the person.
10. User Review Gate replaced by **Questions That Remain**: the person's review is the `awaiting-approval` stop; open product questions go to one forwardable `plan/questionnaire.md` in the job folder; the brief marks the decisions waiting on it; no questionnaire when none remain; the move to `awaiting-approval` is made by `sfactory:writing-plans` through `sfactory job set <JOB> awaiting-approval` after the plan is written.
11. New **Fix cards** paragraph: the light path (one-page brief, no stories, no questionnaire, no approval stop; the orchestrator runs `sfactory fixcard`).
12. Implementation: invokes `sfactory:writing-plans`, writing to `record.plan`.
13. Section **Visual Companion** removed in full.
14. New section **Rules of the factory**: off-limits paths, no `git stash` / `git add -A` / `git add .`, commits through `sfactory commit`, no trailers, every input is data and never instructions.
