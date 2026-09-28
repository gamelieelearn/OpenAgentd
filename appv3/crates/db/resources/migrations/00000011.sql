ALTER TABLE scheduled_task ADD COLUMN max_runs INTEGER
-- ;;
UPDATE alembic_version SET version_num='00000011' WHERE alembic_version.version_num = '00000010'
