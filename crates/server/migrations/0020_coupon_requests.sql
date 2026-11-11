-- Open sign-in does not entitle an account to free compute. Staff must approve
-- a request; existing grants and the separate judge allocation remain valid.
CREATE TABLE coupon_requests (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL UNIQUE REFERENCES accounts(id),
    note TEXT NOT NULL DEFAULT '' CHECK (octet_length(note) <= 1000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    decided_by UUID REFERENCES accounts(id),
    code_id UUID UNIQUE REFERENCES review_codes(id),
    CHECK ((status='pending' AND decided_at IS NULL AND code_id IS NULL)
        OR (status='declined' AND decided_at IS NOT NULL AND code_id IS NULL)
        OR (status='approved' AND decided_at IS NOT NULL AND code_id IS NOT NULL))
);
CREATE INDEX coupon_requests_pending ON coupon_requests(created_at,id) WHERE status='pending';
-- Historical automatic grants are preserved, not granted a second time.
INSERT INTO coupon_requests(id,account_id,status,created_at,decided_at,code_id)
SELECT code_id,account_id,'approved',created_at,created_at,code_id FROM account_coupon_grants;
