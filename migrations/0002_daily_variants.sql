-- For databases created before Lemma of the Day and variants (schema.sql has both for new databases).
ALTER TABLE proofs ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';
CREATE TABLE IF NOT EXISTS daily_results (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         INTEGER NOT NULL,
  solved      INTEGER NOT NULL,
  tries       INTEGER NOT NULL,
  seconds     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
