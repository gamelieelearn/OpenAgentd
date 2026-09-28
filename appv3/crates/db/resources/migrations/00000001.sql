CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL, 
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
)
-- ;;
CREATE TABLE chat_sessions (
	id CHAR(32) NOT NULL, 
	parent_session_id CHAR(32), 
	agent_name VARCHAR(100), 
	title VARCHAR(255), 
	scheduled_task_name VARCHAR(100), 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(parent_session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
)
-- ;;
CREATE INDEX ix_chat_sessions_parent_session_id ON chat_sessions (parent_session_id)
-- ;;
INSERT INTO alembic_version (version_num) VALUES ('00000001') RETURNING version_num
