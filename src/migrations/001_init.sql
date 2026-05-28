-- projects: one row per repo
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  root_path     TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);

-- tickets: the canonical table
CREATE TABLE tickets (
  id           TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,
  priority     TEXT,
  type         TEXT NOT NULL DEFAULT 'task',
  effort       INTEGER CHECK (effort IS NULL OR effort IN (1, 2, 3, 5, 8, 13)),
  epic         TEXT,
  parent_id    TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  closed_at    TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, parent_id) REFERENCES tickets(project_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_tickets_status   ON tickets (project_id, status);
CREATE INDEX idx_tickets_priority ON tickets (project_id, priority);
CREATE INDEX idx_tickets_epic     ON tickets (project_id, epic);
CREATE INDEX idx_tickets_type     ON tickets (project_id, type);
CREATE INDEX idx_tickets_parent   ON tickets (project_id, parent_id);

-- relations: directed, typed edges between tickets
CREATE TABLE relations (
  project_id  TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, from_id, to_id, kind),
  FOREIGN KEY (project_id, from_id) REFERENCES tickets(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_id)   REFERENCES tickets(project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_relations_to   ON relations (project_id, to_id, kind);
CREATE INDEX idx_relations_from ON relations (project_id, from_id, kind);

-- tags: free-form labels
CREATE TABLE tags (
  project_id TEXT NOT NULL,
  ticket_id  TEXT NOT NULL,
  tag        TEXT NOT NULL,
  PRIMARY KEY (project_id, ticket_id, tag),
  FOREIGN KEY (project_id, ticket_id) REFERENCES tickets(project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_tags_tag ON tags (tag);

-- FTS: title + description, porter stemming, title boosted 3x
CREATE VIRTUAL TABLE tickets_fts USING fts5(
  project_id UNINDEXED,
  ticket_id  UNINDEXED,
  title,
  description,
  tokenize = 'porter unicode61'
);

-- audit_log: every write, so "what changed today" is cheap
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  field        TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  changed_at   TEXT NOT NULL
);

CREATE INDEX idx_audit_changed_at ON audit_log (changed_at);
CREATE INDEX idx_audit_ticket     ON audit_log (project_id, ticket_id);

-- triggers: FTS5 synchronisation
CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts (project_id, ticket_id, title, description)
  VALUES (new.project_id, new.id, new.title, new.description);
END;

CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM tickets_fts WHERE project_id = old.project_id AND ticket_id = old.id;
END;

CREATE TRIGGER tickets_fts_au AFTER UPDATE OF title, description ON tickets BEGIN
  UPDATE tickets_fts
    SET title = new.title, description = new.description
    WHERE project_id = new.project_id AND ticket_id = new.id;
END;

-- triggers: closed_at maintenance
CREATE TRIGGER tickets_closed_at_set AFTER UPDATE OF status ON tickets
WHEN new.status IN ('done', 'deferred') AND old.status NOT IN ('done', 'deferred') BEGIN
  UPDATE tickets
    SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE project_id = new.project_id AND id = new.id AND closed_at IS NULL;
END;

CREATE TRIGGER tickets_closed_at_clear AFTER UPDATE OF status ON tickets
WHEN new.status NOT IN ('done', 'deferred') AND old.status IN ('done', 'deferred') BEGIN
  UPDATE tickets SET closed_at = NULL
    WHERE project_id = new.project_id AND id = new.id;
END;
