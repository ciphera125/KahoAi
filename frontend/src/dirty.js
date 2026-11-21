// Whether what is on screen differs from what was last saved, so a Save button can say "Saved" and
// rest until something is edited (owner, 2026-11-22: a Save that always looks ready says nothing).

/** Numbers typed into a box arrive as text; "10" and 10 are the same setting. */
const norm = (v) => {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v ?? null;
};

export const changed = (saved, current) => JSON.stringify(norm(saved)) !== JSON.stringify(norm(current));

export const sameSet = (a, b) => {
  const x = new Set(a ?? []), y = new Set(b ?? []);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/** A question as a person edits it: the server adds its key and who made it, which are not edits. */
const editable = (q) => ({ label: q.label ?? "", kind: q.kind ?? "text", required: !!q.required, ask: q.ask ?? "",
  choices: q.kind === "choice" ? q.choices ?? [] : [] });
export const sameQuestions = (saved, current) => !changed((saved ?? []).map(editable), (current ?? []).map(editable));
