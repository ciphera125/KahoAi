-- 029: tool calls recorded as failed that had worked.
--
-- Until 2026-11-15 the voice service read the advice that rides along with a document search
-- ("answer only from these passages", "say you are not sure") as the tool failing, so every lookup was
-- written with ok = false. A lookup that ran says so with `found`; it worked, whether it found
-- something or nothing. Only rows that say `found` are touched. Safe to run again.
UPDATE call_events SET ok = true
WHERE event = 'tool' AND ok IS FALSE AND name = 'search_knowledge'
  AND (text LIKE '%"found": true%' OR text LIKE '%"found": false%' OR text LIKE '%"found":true%' OR text LIKE '%"found":false%');
