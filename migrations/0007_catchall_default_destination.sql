-- Aliases created by incoming mail used to copy the default forwarding address at the time, so a
-- later change of the default did not reach them. Those still holding the current default follow it again.
UPDATE aliases SET destination = NULL
WHERE note = 'Created by catchall option'
	AND destination IS NOT NULL
	AND destination = (SELECT json_extract(value, '$') FROM settings WHERE key = 'defaultDestination');
