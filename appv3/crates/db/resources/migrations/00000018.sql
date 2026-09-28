ALTER TABLE chat_sessions ADD COLUMN history_revision INTEGER DEFAULT '0' NOT NULL
-- ;;
ALTER TABLE chat_sessions ADD COLUMN history_structure_revision INTEGER DEFAULT '0' NOT NULL
-- ;;
UPDATE alembic_version SET version_num='00000018' WHERE alembic_version.version_num = '00000017'
