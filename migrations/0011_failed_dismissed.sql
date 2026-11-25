-- A failed forward that the apps "delete" is only hidden from the failed-deliveries list: the
-- row is also the forward's retry record and its activity entry.
ALTER TABLE forwards ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;
