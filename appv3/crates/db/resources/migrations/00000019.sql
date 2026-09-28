ALTER TABLE session_messages ADD COLUMN seq INTEGER DEFAULT '0' NOT NULL
-- ;;
ALTER TABLE session_messages ADD COLUMN kind VARCHAR(16) DEFAULT 'chat' NOT NULL
-- ;;
ALTER TABLE session_messages ADD COLUMN pinned BOOLEAN DEFAULT 0 NOT NULL
-- ;;
UPDATE session_messages
        SET seq = ordered.rn * 1024
        FROM (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY session_id
                    ORDER BY created_at, id
                ) AS rn
            FROM session_messages
        ) AS ordered
        WHERE session_messages.id = ordered.id
-- ;;
UPDATE session_messages
        SET kind = CASE
            WHEN json_extract(extra, '$.queue_status') = 'queued'
                THEN 'queued'

            WHEN is_summary = 1 AND COALESCE(json_extract(extra, '$.hidden_from_user'), 0) IN (1, '1', 'true')
                THEN 'reverted'

            WHEN is_summary = 1
                THEN 'summary'

            WHEN COALESCE(json_extract(extra, '$.hidden_from_user'), 0) IN (1, '1', 'true') AND exclude_from_context = 1
                THEN 'reverted'

            WHEN COALESCE(json_extract(extra, '$.hidden_from_user'), 0) IN (1, '1', 'true')
                THEN 'note'

            ELSE 'chat'
        END
        WHERE is_summary = 1
           OR extra IS NOT NULL
-- ;;
CREATE INDEX ix_session_messages_active_summary ON session_messages (session_id, id) WHERE kind = 'summary'
-- ;;
UPDATE session_messages
        SET seq = (
            SELECT s.seq
            FROM session_messages AS s
            WHERE s.session_id = session_messages.session_id
              AND s.kind = 'summary'
            ORDER BY s.id DESC
            LIMIT 1
        )
        WHERE kind IN ('chat', 'note')
          AND exclude_from_context = 1
          AND session_id IN (
              SELECT DISTINCT session_id
              FROM session_messages
              WHERE kind = 'summary'
          )
          AND id < (
              SELECT s.id
              FROM session_messages AS s
              WHERE s.session_id = session_messages.session_id
                AND s.kind = 'summary'
              ORDER BY s.id DESC
              LIMIT 1
          )
          AND (seq, id) > (
              SELECT s.seq, s.id
              FROM session_messages AS s
              WHERE s.session_id = session_messages.session_id
                AND s.kind = 'summary'
              ORDER BY s.id DESC
              LIMIT 1
          )
-- ;;
UPDATE session_messages
        SET kind = 'reverted'
        WHERE kind IN ('chat', 'note')
          AND exclude_from_context = 1
          AND (
              session_id NOT IN (
                  SELECT DISTINCT session_id
                  FROM session_messages
                  WHERE kind = 'summary'
              )
              OR (seq, id) > (
                  SELECT s.seq, s.id
                  FROM session_messages AS s
                  WHERE s.session_id = session_messages.session_id
                    AND s.kind = 'summary'
                  ORDER BY s.id DESC
                  LIMIT 1
              )
          )
-- ;;
UPDATE session_messages
        SET pinned = 1
        WHERE kind IN ('chat', 'note')
          AND exclude_from_context = 0
          AND session_id IN (
              SELECT DISTINCT session_id
              FROM session_messages
              WHERE kind = 'summary'
          )
          AND seq < (
              SELECT s.seq
              FROM session_messages AS s
              WHERE s.session_id = session_messages.session_id
                AND s.kind = 'summary'
              ORDER BY s.id DESC
              LIMIT 1
          )
-- ;;
ALTER TABLE session_messages DROP COLUMN is_summary
-- ;;
ALTER TABLE session_messages DROP COLUMN exclude_from_context
-- ;;
DROP INDEX ix_session_messages_session_created_id
-- ;;
CREATE INDEX ix_session_messages_session_seq_id ON session_messages (session_id, seq, id)
-- ;;
UPDATE alembic_version SET version_num='00000019' WHERE alembic_version.version_num = '00000018'
