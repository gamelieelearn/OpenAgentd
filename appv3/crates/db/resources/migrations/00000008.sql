ALTER TABLE chat_sessions ADD COLUMN model VARCHAR(255)
-- ;;
ALTER TABLE chat_sessions ADD COLUMN thinking_level VARCHAR(50)
-- ;;
UPDATE alembic_version SET version_num='00000008' WHERE alembic_version.version_num = '00000007'
