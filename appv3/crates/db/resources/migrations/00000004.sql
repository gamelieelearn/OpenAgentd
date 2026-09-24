CREATE TABLE dream_log (
	id INTEGER NOT NULL, 
	session_id TEXT NOT NULL, 
	processed_at DATETIME NOT NULL, 
	agent_name TEXT, 
	topics_written TEXT, 
	PRIMARY KEY (id), 
	UNIQUE (session_id)
)
-- ;;
CREATE UNIQUE INDEX ix_dream_log_session_id ON dream_log (session_id)
-- ;;
CREATE TABLE dream_notes_log (
	id INTEGER NOT NULL, 
	filename TEXT NOT NULL, 
	processed_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (filename)
)
-- ;;
CREATE UNIQUE INDEX ix_dream_notes_log_filename ON dream_notes_log (filename)
-- ;;
UPDATE alembic_version SET version_num='00000004' WHERE alembic_version.version_num = '00000003'
