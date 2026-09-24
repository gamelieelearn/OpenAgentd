CREATE TABLE scheduled_task (
	id CHAR(32) NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	agent VARCHAR(100) NOT NULL, 
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
	PRIMARY KEY (id)
)
-- ;;
CREATE UNIQUE INDEX ix_scheduled_task_name ON scheduled_task (name)
-- ;;
CREATE INDEX ix_scheduled_task_enabled ON scheduled_task (enabled)
-- ;;
UPDATE alembic_version SET version_num='00000003' WHERE alembic_version.version_num = '00000002'
