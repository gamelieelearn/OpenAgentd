CREATE INDEX ix_chat_sessions_top_mode_created ON chat_sessions (parent_session_id, mode, created_at)
-- ;;
CREATE INDEX ix_chat_sessions_top_mode_workspace_created ON chat_sessions (parent_session_id, mode, workspace, created_at)
-- ;;
UPDATE alembic_version SET version_num='00000014' WHERE alembic_version.version_num = '00000013'
