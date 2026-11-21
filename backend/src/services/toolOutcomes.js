// Start-up pass: what each tool call came to, for lines written before that was kept (migration 032),
// and again for every line whenever the reading itself changes (OUTCOME_VERSION).
//
// It runs on the owner's connection, like the migrations, in batches, and only ever sets `outcome`: the
// line itself is not touched. Safe to run on every start; a second run with nothing to do changes nothing.
import { ownerPool } from "../db/pool.js";
import { classify } from "../models/toolOutcome.js";

/** Raise this when toolOutcome.js or toolReasons.json reads a line differently, so old lines are read again. */
export const OUTCOME_VERSION = 1;
const BATCH = 500;

export async function backfillToolOutcomes() {
  const pool = ownerPool();
  const client = await pool.connect();
  let changed = 0;
  try {
    await client.query("SELECT set_config('app.bypass', 'on', false)");
    const stored = Number((await client.query("SELECT value FROM meta WHERE key = 'tool_outcome_version'")).rows[0]?.value ?? 0);
    const all = stored < OUTCOME_VERSION; // a new reading: every line, not only the empty ones
    let after = 0;
    for (;;) {
      const { rows } = await client.query(
        `SELECT e.id, e.event, e.name, e.ok, e.text, e.outcome,
           CASE WHEN e.event = 'tool_rejected' AND c.agent_id IS NOT NULL THEN coalesce(
             (SELECT av.tools FROM agent_versions av WHERE av.agent_id = c.agent_id AND av.number = c.agent_version),
             (SELECT a.tools FROM agents a WHERE a.id = c.agent_id)) END AS attached
         FROM call_events e LEFT JOIN calls c ON c.call_id = e.call_id
         WHERE e.event IN ('tool', 'tool_rejected') AND e.id > $1 AND ($2 OR e.outcome IS NULL)
         ORDER BY e.id LIMIT ${BATCH}`, [after, all]);
      if (!rows.length) break;
      for (const r of rows) {
        const outcome = classify({ event: r.event, name: r.name, ok: r.ok, text: r.text, attached: r.attached });
        if (outcome !== r.outcome) {
          await client.query("UPDATE call_events SET outcome = $2 WHERE id = $1", [r.id, outcome]);
          changed++;
        }
      }
      after = Number(rows[rows.length - 1].id);
    }
    await client.query(`INSERT INTO meta (key, value) VALUES ('tool_outcome_version', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(OUTCOME_VERSION)]);
  } finally {
    client.release();
    await pool.end();
  }
  return { changed };
}
