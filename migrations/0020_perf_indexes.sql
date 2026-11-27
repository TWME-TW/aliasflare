-- Performance indexes to eliminate full table scans on hot D1 paths (mailbox quota/stats/cleanup,
-- SMTP hourly rate-limit checks, and active destination aggregation).
CREATE INDEX IF NOT EXISTS events_kind_created_idx ON events (kind, created_at);
CREATE INDEX IF NOT EXISTS mailbox_messages_folder_flags_idx ON mailbox_messages (folder, flags);
CREATE INDEX IF NOT EXISTS mailbox_messages_stored_idx ON mailbox_messages (storage_kind, folder, created_at, size_bytes) WHERE storage_kind != 'headers_only';
CREATE INDEX IF NOT EXISTS mailbox_messages_trash_updated_idx ON mailbox_messages (folder, updated_at) WHERE folder = 'Trash';
CREATE INDEX IF NOT EXISTS aliases_deleted_dest_idx ON aliases (deleted_at, destination);
