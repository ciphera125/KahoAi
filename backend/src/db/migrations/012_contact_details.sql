-- 012: whatever else a customer knows about a contact.
--
-- An agent is often told things the Studio has no column for: an age, a loan amount, a
-- branch. These arrive from the customer's own system, so they are kept as they are sent
-- rather than guessed at here, and the "Look Up Contact Details" tool reads them out.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
