CREATE INDEX ix_session_messages_session_created_id ON session_messages (session_id, created_at, id)
-- ;;
DROP INDEX ix_session_messages_session_created
-- ;;
DROP INDEX ix_session_messages_session_summary
-- ;;
DROP INDEX ix_session_messages_session_id
-- ;;
CREATE INDEX ix_chat_sessions_parent_created ON chat_sessions (parent_session_id, created_at)
-- ;;
DROP INDEX ix_chat_sessions_parent_session_id
-- ;;
DROP INDEX ix_chat_sessions_parent_agent_created
-- ;;
CREATE INDEX ix_chat_sessions_parent_agent_created ON chat_sessions (parent_session_id, agent_name, created_at)
-- ;;
DROP INDEX ix_scheduled_task_enabled
-- ;;
UPDATE alembic_version SET version_num='00000017' WHERE alembic_version.version_num = '00000016'
