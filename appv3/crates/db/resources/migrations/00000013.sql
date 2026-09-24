ALTER TABLE scheduled_task ADD COLUMN slug VARCHAR(100)
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
	mode VARCHAR(20) DEFAULT 'normal' NOT NULL, 
	workspace VARCHAR, 
	max_runs INTEGER, 
	slug VARCHAR(100) NOT NULL, 
	PRIMARY KEY (id)
)
-- ;;
INSERT INTO _alembic_tmp_scheduled_task (id, name, schedule_type, at_datetime, every_seconds, cron_expression, timezone, prompt, session_id, enabled, status, run_count, last_run_at, last_error, next_fire_at, created_at, updated_at, mode, workspace, max_runs, slug) SELECT scheduled_task.id, scheduled_task.name, scheduled_task.schedule_type, scheduled_task.at_datetime, scheduled_task.every_seconds, scheduled_task.cron_expression, scheduled_task.timezone, scheduled_task.prompt, scheduled_task.session_id, scheduled_task.enabled, scheduled_task.status, scheduled_task.run_count, scheduled_task.last_run_at, scheduled_task.last_error, scheduled_task.next_fire_at, scheduled_task.created_at, scheduled_task.updated_at, scheduled_task.mode, scheduled_task.workspace, scheduled_task.max_runs, scheduled_task.slug 
FROM scheduled_task
-- ;;
DROP TABLE scheduled_task
-- ;;
ALTER TABLE _alembic_tmp_scheduled_task RENAME TO scheduled_task
-- ;;
CREATE UNIQUE INDEX ix_scheduled_task_name ON scheduled_task (name)
-- ;;
CREATE INDEX ix_scheduled_task_enabled ON scheduled_task (enabled)
-- ;;
CREATE UNIQUE INDEX ix_scheduled_task_slug ON scheduled_task (slug)
-- ;;
UPDATE alembic_version SET version_num='00000013' WHERE alembic_version.version_num = '00000012'
