-- Who made a tool: the person on the form, or Kaho Builder from a chat. Shown beside the tool so people
-- can see what the assistant set up for them.
ALTER TABLE custom_tools ADD COLUMN made_by text NOT NULL DEFAULT 'form' CHECK (made_by IN ('form', 'builder'));
