-- Partial indexes for active failed deliveries (/api/v1/failed-deliveries) and daily unsubscribe cleanup.
CREATE INDEX IF NOT EXISTS forwards_failed_active_idx ON forwards (created_at DESC) WHERE status = 'failed' AND dismissed = 0;
CREATE INDEX IF NOT EXISTS forwards_unsub_cleanup_idx ON forwards (created_at) WHERE original_unsubscribe IS NOT NULL;
