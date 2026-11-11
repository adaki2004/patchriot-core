-- The launch pool is fixed at 100 lifetime grants, never replenished by expiry
-- or redemption. Judge grants have a separate one-per-account allocation.
CREATE TABLE welcome_coupon_program (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    starts_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO welcome_coupon_program(singleton) VALUES(true);
CREATE TABLE account_coupon_grants (
    account_id UUID PRIMARY KEY REFERENCES accounts(id),
    code_id UUID NOT NULL UNIQUE REFERENCES review_codes(id),
    public_slot INTEGER NOT NULL UNIQUE CHECK (public_slot BETWEEN 1 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE judge_coupon_pool (
    slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 8),
    code_id UUID NOT NULL UNIQUE REFERENCES review_codes(id),
    display_code TEXT NOT NULL CHECK (display_code ~ '^pr-[a-f0-9]{64}$'),
    granted_by UUID NOT NULL REFERENCES accounts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retire automatic access to any older public campaign; existing issued codes survive.
UPDATE trial_campaign SET stopped_at=COALESCE(stopped_at,now());
