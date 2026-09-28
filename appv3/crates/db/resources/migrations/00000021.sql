DELETE FROM scheduled_task WHERE workspace IS NULL OR mode = 'normal'
-- ;;
DELETE FROM chat_sessions WHERE workspace IS NULL OR mode = 'normal'
-- ;;
CREATE TABLE _alembic_tmp_chat_sessions (
	id CHAR(32) NOT NULL, 
	parent_session_id CHAR(32), 
	agent_name VARCHAR(100), 
	title VARCHAR(255), 
	scheduled_task_name VARCHAR(100), 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	workspace VARCHAR NOT NULL, 
	revert JSON, 
	model VARCHAR(255), 
	thinking_level VARCHAR(50), 
	history_revision INTEGER DEFAULT '0' NOT NULL, 
	history_structure_revision INTEGER DEFAULT '0' NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(parent_session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
)
-- ;;
INSERT INTO _alembic_tmp_chat_sessions (id, parent_session_id, agent_name, title, scheduled_task_name, created_at, updated_at, workspace, revert, model, thinking_level, history_revision, history_structure_revision) SELECT chat_sessions.id, chat_sessions.parent_session_id, chat_sessions.agent_name, chat_sessions.title, chat_sessions.scheduled_task_name, chat_sessions.created_at, chat_sessions.updated_at, chat_sessions.workspace, chat_sessions.revert, chat_sessions.model, chat_sessions.thinking_level, chat_sessions.history_revision, chat_sessions.history_structure_revision 
FROM chat_sessions
-- ;;
DROP TABLE chat_sessions
-- ;;
ALTER TABLE _alembic_tmp_chat_sessions RENAME TO chat_sessions
-- ;;
CREATE INDEX ix_chat_sessions_parent_created ON chat_sessions (parent_session_id, created_at, id)
-- ;;
CREATE INDEX ix_chat_sessions_parent_agent_created ON chat_sessions (parent_session_id, agent_name, created_at)
-- ;;
CREATE INDEX ix_chat_sessions_top_created ON chat_sessions (parent_session_id, created_at, id)
-- ;;
CREATE INDEX ix_chat_sessions_top_workspace_created ON chat_sessions (parent_session_id, workspace, created_at, id)
-- ;;
CREATE TABLE _alembic_tmp_scheduled_task (
	id CHAR(32) NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	schedule_type VARCHAR(20) NOT NULL, 
	at_datetime DATETIME, 
	every_seconds INTEGER, 
	cron_expression VARCHAR(100), 
	timezone VARCHAR(50) DEFAULT 'UTC' NOT NULL, 
	prompt TEXT NOT NULL, 
	session_id VARCHAR(200), 
	enabled BOOLEAN DEFAULT 1 NOT NULL, 
	status VARCHAR(20) DEFAULT 'pending' NOT NULL, 
	run_count INTEGER DEFAULT '0' NOT NULL, 
	last_run_at DATETIME, 
	last_error TEXT, 
	next_fire_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	workspace VARCHAR NOT NULL, 
	max_runs INTEGER, 
	slug VARCHAR(100) NOT NULL, 
	PRIMARY KEY (id)
)
-- ;;
INSERT INTO _alembic_tmp_scheduled_task (id, name, schedule_type, at_datetime, every_seconds, cron_expression, timezone, prompt, session_id, enabled, status, run_count, last_run_at, last_error, next_fire_at, created_at, updated_at, workspace, max_runs, slug) SELECT scheduled_task.id, scheduled_task.name, scheduled_task.schedule_type, scheduled_task.at_datetime, scheduled_task.every_seconds, scheduled_task.cron_expression, scheduled_task.timezone, scheduled_task.prompt, scheduled_task.session_id, scheduled_task.enabled, scheduled_task.status, scheduled_task.run_count, scheduled_task.last_run_at, scheduled_task.last_error, scheduled_task.next_fire_at, scheduled_task.created_at, scheduled_task.updated_at, scheduled_task.workspace, scheduled_task.max_runs, scheduled_task.slug 
FROM scheduled_task
-- ;;
DROP TABLE scheduled_task
-- ;;
ALTER TABLE _alembic_tmp_scheduled_task RENAME TO scheduled_task
-- ;;
CREATE UNIQUE INDEX ix_scheduled_task_name ON scheduled_task (name)
-- ;;
CREATE UNIQUE INDEX ix_scheduled_task_slug ON scheduled_task (slug)
-- ;;
UPDATE alembic_version SET version_num='00000021' WHERE alembic_version.version_num = '00000020'
