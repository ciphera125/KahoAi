-- How the caller left the call, judged once from the summary after the call ends.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS sentiment text CHECK (sentiment IN ('positive', 'neutral', 'negative'));
