CREATE INDEX ix_session_messages_session_id ON session_messages (session_id, id)
-- ;;
DROP INDEX ix_chat_sessions_top_mode_created
-- ;;
DROP INDEX ix_chat_sessions_top_mode_workspace_created
-- ;;
DROP INDEX ix_chat_sessions_parent_created
-- ;;
CREATE INDEX ix_chat_sessions_top_mode_created ON chat_sessions (parent_session_id, mode, created_at, id)
-- ;;
CREATE INDEX ix_chat_sessions_top_mode_workspace_created ON chat_sessions (parent_session_id, mode, workspace, created_at, id)
-- ;;
CREATE INDEX ix_chat_sessions_parent_created ON chat_sessions (parent_session_id, created_at, id)
-- ;;
UPDATE alembic_version SET version_num='00000020' WHERE alembic_version.version_num = '00000019'
