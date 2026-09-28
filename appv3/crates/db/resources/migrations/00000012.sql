DROP INDEX ix_dream_notes_log_filename
-- ;;
DROP TABLE dream_notes_log
-- ;;
DROP INDEX ix_dream_log_session_id
-- ;;
DROP TABLE dream_log
-- ;;
DROP INDEX ix_memory_processed_sources_source_id
-- ;;
DROP INDEX ix_memory_processed_sources_source_type
-- ;;
DROP TABLE memory_processed_sources
-- ;;
UPDATE alembic_version SET version_num='00000012' WHERE alembic_version.version_num = '00000011'
