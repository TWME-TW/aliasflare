-- The first label colours were the dashboard's old palette: move them to the new one.
UPDATE labels SET colour = CASE colour
	WHEN '#1a73e8' THEN '#6366f1'
	WHEN '#188038' THEN '#10b981'
	WHEN '#e37400' THEN '#f59e0b'
	WHEN '#d93025' THEN '#f43f5e'
	WHEN '#9334e6' THEN '#8b5cf6'
	WHEN '#007b83' THEN '#14b8a6'
	WHEN '#c5221f' THEN '#ec4899'
	WHEN '#5f6368' THEN '#64748b'
	ELSE colour END;
