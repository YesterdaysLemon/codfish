-- Blocks proofs keep the blocks they were built from (JSON); NULL for everything else.
ALTER TABLE proofs ADD COLUMN blocks TEXT;
