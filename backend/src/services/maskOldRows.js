// One-off clean-up at start-up: Builder prompts and replies saved before they were masked at insert.
// builder_history is append-only for the application (it has no UPDATE right), so this runs on the
// owner's connection, like the migrations, and only ever replaces text with its masked form.
// Safe to run every start: a row that is already clean is left alone, and a second run changes nothing.
import { ownerPool } from "../db/pool.js";
import { redactPII } from "../models/redact.js";

export async function maskOldBuilderHistory() {
  const pool = ownerPool();
  const client = await pool.connect();
  let changed = 0;
  try {
    await client.query("SELECT set_config('app.bypass', 'on', false)");
    const { rows } = await client.query("SELECT id, prompt, reply FROM builder_history ORDER BY id");
    for (const r of rows) {
      const prompt = redactPII(r.prompt);
      const reply = redactPII(r.reply);
      if (prompt === r.prompt && reply === r.reply) continue;
      await client.query("UPDATE builder_history SET prompt = $2, reply = $3 WHERE id = $1", [r.id, prompt, reply]);
      changed++;
    }
  } finally {
    client.release();
    await pool.end();
  }
  return { changed };
}
