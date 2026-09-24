CREATE TABLE pending_questions (
	id CHAR(32) NOT NULL, 
	session_id CHAR(32) NOT NULL, 
	tool_call_id VARCHAR(100) NOT NULL, 
	payload JSON NOT NULL, 
	status VARCHAR(20) DEFAULT 'pending' NOT NULL, 
	answers JSON, 
	created_at DATETIME NOT NULL, 
	answered_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE, 
	CONSTRAINT uq_pending_questions_tool_call_id UNIQUE (tool_call_id)
)
-- ;;
CREATE INDEX ix_pending_questions_session_id ON pending_questions (session_id)
-- ;;
CREATE INDEX ix_pending_questions_status ON pending_questions (status)
-- ;;
CREATE UNIQUE INDEX uq_pending_questions_open_per_session ON pending_questions (session_id) WHERE status = 'pending'
-- ;;
UPDATE alembic_version SET version_num='00000016' WHERE alembic_version.version_num = '00000015'
