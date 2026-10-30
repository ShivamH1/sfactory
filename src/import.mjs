import { fail } from "./errors.mjs";
import { NUMBER_RE, newJob } from "./job.mjs";
import { addJobWith, listJobs, writeJobFile } from "./store.mjs";
import { withRecordLock } from "./record.mjs";

const STAGES = ["roadmap", "backlog", "external", "pushed", "merged"];
const FIELDS = ["number", "kind", "title", "stage", "branch", "pr", "prUrl", "started", "ended", "after", "externalNote", "note"];

const text = (v, max) => typeof v === "string" && v.trim() !== "" && v.length <= max;
const iso = (v) => { const t = Date.parse(v); return typeof v === "string" && !Number.isNaN(t) ? new Date(t).toISOString() : null; };

/** Check a whole import document; return the cards normalised (dates as ISO strings), or throw BAD_IMPORT naming the first bad field. */
export function validateImport(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.cards)) fail("BAD_IMPORT", 'the file must be a JSON object with a "cards" array');
  const seen = new Map();
  const cards = doc.cards.map((card, i) => {
    const at = (f) => `cards[${i}].${f}`;
    const no = (f, why) => fail("BAD_IMPORT", `${at(f)}: ${why}`);
    if (!card || typeof card !== "object" || Array.isArray(card)) fail("BAD_IMPORT", `cards[${i}]: must be an object`);
    for (const k of Object.keys(card)) if (!FIELDS.includes(k)) no(k, "is not a field an import card takes");
    if (!["milestone", "fix"].includes(card.kind)) no("kind", 'must be "milestone" or "fix"');
    if (!text(card.title, 200)) no("title", "must be text of at most 200 characters");
    if (!STAGES.includes(card.stage)) no("stage", `must be one of ${STAGES.join(", ")}`);
    const out = { kind: card.kind, title: card.title.trim(), stage: card.stage };
    if (card.number !== undefined) {
      if (card.kind !== "milestone") no("number", "only a milestone carries a number");
      if (typeof card.number !== "string" || !NUMBER_RE.test(card.number)) no("number", 'must be a string like "14" or "29.1"');
      if (seen.has(card.number)) no("number", `M${card.number} is also cards[${seen.get(card.number)}]`);
      seen.set(card.number, i);
      out.number = card.number;
    }
    if (card.branch !== undefined) { if (!text(card.branch, 200)) no("branch", "must be text of at most 200 characters"); out.branch = card.branch.trim(); }
    if (card.pr !== undefined) { if (!Number.isInteger(card.pr) || card.pr < 1) no("pr", "must be a positive whole number"); out.pr = card.pr; }
    if (card.prUrl !== undefined) { if (!text(card.prUrl, 500) || !/^https?:\/\//.test(card.prUrl)) no("prUrl", "must be an http(s) URL"); out.prUrl = card.prUrl; }
    if (card.started !== undefined) { out.started = iso(card.started) ?? no("started", "must be a date or date-time"); }
    if (card.ended !== undefined) {
      if (card.stage !== "merged") no("ended", "only a merged card has an end");
      out.ended = iso(card.ended) ?? no("ended", "must be a date or date-time");
    }
    if (card.after !== undefined) { if (!text(card.after, 80)) no("after", "must be text of at most 80 characters"); out.after = card.after.trim(); }
    if (card.externalNote !== undefined) {
      if (card.stage !== "external") no("externalNote", "only an external card has an external note");
      if (!text(card.externalNote, 200)) no("externalNote", "must be text of at most 200 characters");
      out.externalNote = card.externalNote.trim();
    }
    if (card.note !== undefined) { if (!text(card.note, 2000)) no("note", "must be text of at most 2,000 characters"); out.note = card.note; }
    return out;
  });
  return { cards };
}

/** The job object an import card becomes. */
function jobOf(id, card, now) {
  const started = card.started ?? now;
  const base = newJob({ id, kind: card.kind, title: card.title, now: started });
  return {
    ...base,
    stage: card.stage,
    ...(card.number !== undefined ? { number: card.number } : {}),
    ...(card.after !== undefined ? { after: card.after } : {}),
    ...(card.externalNote !== undefined ? { externalNote: card.externalNote } : {}),
    ...(card.branch !== undefined ? { branch: card.branch } : {}),
    ...(card.pr !== undefined ? { pr: card.pr } : {}),
    ...(card.prUrl !== undefined ? { prUrl: card.prUrl } : {}),
    ended: card.stage === "merged" ? (card.ended ?? now) : null,
    history: [{ at: started, from: null, to: card.stage, by: "import", reason: "imported" }],
  };
}

/**
 * Validate the whole document, then create each card not already on the board (a number already carried, or for an
 * unnumbered card the same kind and title), in file order, under the record lock so a concurrent add cannot take a
 * number between the check and the write.
 */
export function importCards(c, doc, { now = new Date().toISOString() } = {}) {
  const { cards } = validateImport(doc);
  return withRecordLock(c, "import", () => {
    const created = [], skipped = [];
    cards.forEach((card, index) => {
      const jobs = listJobs(c);
      const held = card.number !== undefined
        ? jobs.find((j) => j.number === card.number)
        : jobs.find((j) => j.kind === card.kind && j.title === card.title);
      if (held) {
        skipped.push({ index, reason: card.number !== undefined ? `M${card.number} is ${held.id}` : `a ${card.kind} titled "${card.title}" is ${held.id}` });
        return;
      }
      const job = addJobWith(c, card.kind, (id) => jobOf(id, card, now));
      if (card.pr !== undefined) writeJobFile(c, job.id, "pr.md", `PR #${card.pr}${card.branch ? ` · ${card.branch}` : ""}\n${card.prUrl ? `${card.prUrl}\n` : ""}`);
      if (card.note !== undefined) writeJobFile(c, job.id, "notes.md", card.note.endsWith("\n") ? card.note : `${card.note}\n`);
      created.push({ index, id: job.id, ...(card.number !== undefined ? { number: card.number } : {}), stage: card.stage });
    });
    return { created, skipped };
  });
}
