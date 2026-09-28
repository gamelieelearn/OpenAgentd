CREATE TABLE session_messages (
	id CHAR(32) NOT NULL, 
	session_id CHAR(32) NOT NULL, 
	role VARCHAR(50) NOT NULL, 
	content VARCHAR, 
	reasoning_content VARCHAR, 
	tool_calls JSON, 
	tool_call_id VARCHAR(100), 
	name VARCHAR(100), 
	extra JSON, 
	is_summary BOOLEAN DEFAULT 0 NOT NULL, 
	exclude_from_context BOOLEAN DEFAULT 0 NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
)
-- ;;
CREATE INDEX ix_session_messages_session_id ON session_messages (session_id)
-- ;;
CREATE INDEX ix_session_messages_session_created ON session_messages (session_id, created_at)
-- ;;
CREATE INDEX ix_session_messages_session_summary ON session_messages (session_id, is_summary)
-- ;;
UPDATE alembic_version SET version_num='00000002' WHERE alembic_version.version_num = '00000001'
