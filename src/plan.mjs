const norm = (p) => p.trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "");

export function parsePlan(md) {
  const tasks = [];
  let cur = null;
  for (const raw of String(md).split(/\r?\n/)) {
    const h = raw.match(/^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/i);
    if (h) {
      cur = { n: Number(h[1]), title: h[2].replace(/\s*\(after Task (\d+)\)\s*$/i, "").trim(), files: [], dependsOn: [] };
      const after = h[2].match(/\(after Task (\d+)\)/i); if (after) cur.dependsOn.push(Number(after[1]));
      tasks.push(cur); continue;
    }
    if (!cur) continue;
    const f = raw.match(/^\s*-\s*(Create|Modify|Test)\s*:\s*(.+?)\s*$/i);
    if (f) { cur.files.push({ op: f[1].toLowerCase(), path: norm(f[2]) }); continue; }
    const d = raw.match(/depends on\s*:?\*{0,2}\s*(.+)$/i);
    if (d) for (const m of d[1].matchAll(/\d+/g)) { const n = Number(m[0]); if (!cur.dependsOn.includes(n)) cur.dependsOn.push(n); }
  }
  return { tasks };
}
