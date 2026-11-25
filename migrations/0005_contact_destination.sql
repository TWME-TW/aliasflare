-- Per-contact forwarding address: an unsubscribe can send one sender's mail elsewhere.
ALTER TABLE contacts ADD COLUMN destination TEXT;
