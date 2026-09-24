ALTER TABLE chat_sessions ADD COLUMN mode VARCHAR(20) DEFAULT 'normal' NOT NULL
-- ;;
ALTER TABLE chat_sessions ADD COLUMN workspace VARCHAR
-- ;;
UPDATE alembic_version SET version_num='00000005' WHERE alembic_version.version_num = '00000004'
