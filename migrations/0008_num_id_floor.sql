-- Numeric ids (the SimpleLogin API's) are never handed out twice: a permanently deleted alias's or
-- contact's number stays taken, so an app holding it cannot reach a newer one by mistake.
CREATE TABLE IF NOT EXISTS num_id_floor (tbl TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO num_id_floor (tbl, value) VALUES ('aliases', (SELECT COALESCE(MAX(num_id), 0) FROM aliases));
INSERT OR IGNORE INTO num_id_floor (tbl, value) VALUES ('contacts', (SELECT COALESCE(MAX(num_id), 0) FROM contacts));
CREATE TRIGGER IF NOT EXISTS aliases_num_id_floor AFTER DELETE ON aliases BEGIN
	UPDATE num_id_floor SET value = MAX(value, COALESCE(OLD.num_id, 0)) WHERE tbl = 'aliases';
END;
CREATE TRIGGER IF NOT EXISTS contacts_num_id_floor AFTER DELETE ON contacts BEGIN
	UPDATE num_id_floor SET value = MAX(value, COALESCE(OLD.num_id, 0)) WHERE tbl = 'contacts';
END;
CREATE INDEX IF NOT EXISTS aliases_created_idx ON aliases (created_at);
