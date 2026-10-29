const esc = (s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** `**` matches any depth, `*` one path segment, anything else exactly. */
export function globToRegExp(pattern) {
  const p = norm(pattern);
  let out = "";
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*" && p[i + 1] === "*") {
      i++;
      if (p[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (p[i] === "*") out += "[^/]*";
    else out += esc(p[i]);
  }
  return new RegExp(`^${out}$`);
}

/** Files of the plan that match a fixCardRefusals pattern: a hit means the card is a milestone, not a fix. */
export function checkFixCard(c, plan) {
  const res = (c.fixCardRefusals ?? []).map((pattern) => ({ pattern, re: globToRegExp(pattern) }));
  const hits = [];
  const seen = new Set();
  for (const t of plan.tasks) for (const f of t.files) {
    const file = norm(f.path);
    for (const { pattern, re } of res) {
      const key = `${file}\0${pattern}`;
      if (re.test(file) && !seen.has(key)) { seen.add(key); hits.push({ file, pattern }); }
    }
  }
  return { ok: hits.length === 0, hits };
}
