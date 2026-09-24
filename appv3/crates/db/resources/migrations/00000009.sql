CREATE TABLE memory_processed_sources (
	id INTEGER NOT NULL, 
	source_type VARCHAR(50) NOT NULL, 
	source_id VARCHAR(255) NOT NULL, 
	content_hash VARCHAR(64) NOT NULL, 
	processed_at DATETIME NOT NULL, 
	pages_changed TEXT, 
	status VARCHAR(20) NOT NULL, 
	error TEXT, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_memory_processed_sources_source UNIQUE (source_type, source_id)
)
-- ;;
CREATE INDEX ix_memory_processed_sources_source_type ON memory_processed_sources (source_type)
-- ;;
CREATE INDEX ix_memory_processed_sources_source_id ON memory_processed_sources (source_id)
-- ;;
UPDATE alembic_version SET version_num='00000009' WHERE alembic_version.version_num = '00000008'
