ALTER TABLE chat_sessions ADD COLUMN interaction_mode VARCHAR(16) DEFAULT 'code' NOT NULL
-- ;;
UPDATE alembic_version SET version_num='00000022' WHERE alembic_version.version_num = '00000021'
