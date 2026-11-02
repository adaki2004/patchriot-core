-- Existing website reservations retain their original fields and retry identity.
ALTER TABLE review_codes ADD COLUMN source_id UUID;
ALTER TABLE review_codes DROP CONSTRAINT review_codes_check;
ALTER TABLE review_codes ADD CONSTRAINT review_codes_material CHECK (
    (account_id IS NULL AND request_id IS NULL AND site_check_id IS NULL AND source_id IS NULL AND consent IS NULL AND reserved_at IS NULL)
    OR (account_id IS NOT NULL AND request_id IS NOT NULL AND ((site_check_id IS NOT NULL) <> (source_id IS NOT NULL)) AND consent IS NOT NULL AND reserved_at IS NOT NULL)
);
