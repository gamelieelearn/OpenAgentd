ALTER TABLE chat_sessions ADD COLUMN revert JSON
-- ;;
UPDATE alembic_version SET version_num='00000007' WHERE alembic_version.version_num = '00000006'
