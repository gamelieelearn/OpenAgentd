CREATE TABLE coding_workspaces (
	id CHAR(32) NOT NULL, 
	path VARCHAR NOT NULL, 
	kind VARCHAR(20) DEFAULT 'repo' NOT NULL, 
	source_path VARCHAR, 
	name VARCHAR(255), 
	managed BOOLEAN DEFAULT 0 NOT NULL, 
	hidden BOOLEAN DEFAULT 0 NOT NULL, 
	deleted_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_coding_workspaces_path UNIQUE (path)
)
-- ;;
CREATE INDEX ix_coding_workspaces_source_path ON coding_workspaces (source_path)
-- ;;
UPDATE alembic_version SET version_num='00000010' WHERE alembic_version.version_num = '00000009'
