/**
 * The {{placeholders}} a Codex prompt (prompts/*.md) may use, with what each is and who fills it.
 * Agent files (agents/*.md) carry none: Claude Code never renders them, the dispatch message supplies the fields.
 * Text placeholders (*_text) are inlined by the producer inside a fenced data block.
 */
export const PLACEHOLDERS = {
  job: { doc: "The job id, for messages.", producer: "job.mjs (job record id)" },
  worktree: { doc: "Absolute path of the card's worktree.", producer: "worktree.mjs (job record)" },
  secrets: { doc: "A description of the paths under secrets.neverHandToAgents, never the paths themselves.", producer: "prompt renderer (constant sentence)" },
  files: { doc: "The files the task may touch, one per line.", producer: "plan.mjs (task file list)" },
  test_command: { doc: "The suite command from config.", producer: "config.mjs (commands.suite)" },
  brief: { doc: "Path of the brief in the record.", producer: "config record paths" },
  plan: { doc: "Path of the plan in the record.", producer: "config record paths" },
  log: { doc: "Path of the decision log in the record.", producer: "config record paths" },
  base: { doc: "Commit before the work under review.", producer: "git.mjs (task base sha)" },
  head: { doc: "Commit at the end of the work under review.", producer: "git.mjs (task head sha)" },
  task_text: { doc: "The task's text from the plan, inlined as data.", producer: "plan.mjs (task brief)" },
  brief_text: { doc: "The brief's text, inlined as data.", producer: "prompt renderer (reads the brief)" },
  findings_text: { doc: "Findings under verification in a re-review, inlined as data.", producer: "orchestrator (previous review file)" },
  implementer_report_text: { doc: "The implementer's report (the fix report in a re-review), inlined as data.", producer: "orchestrator (the task's report file)" },
  reviews_text: { doc: "The stored reviews of the job, inlined as data.", producer: "prompt renderer (reviews/ folder)" },
};
export const KNOWN_PLACEHOLDERS = new Set(Object.keys(PLACEHOLDERS));
