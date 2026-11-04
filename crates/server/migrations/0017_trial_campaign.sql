-- One lifetime trial per account. Claims reserve sponsorship, never cash.
CREATE TABLE trial_campaign (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    campaign_id UUID NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    claim_limit INTEGER NOT NULL CHECK (claim_limit BETWEEN 1 AND 10000),
    claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed >= 0 AND claimed <= claim_limit),
    stopped_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES accounts(id),
    CHECK (ends_at > started_at AND ends_at <= started_at + interval '48 hours')
);
CREATE TABLE trial_claims (
    account_id UUID PRIMARY KEY REFERENCES accounts(id),
    campaign_id UUID NOT NULL,
    code_id UUID NOT NULL UNIQUE REFERENCES review_codes(id),
    -- Account-bound, unlike transferable operator coupons. Retained so an
    -- authenticated owner can recover a lost reply without receiving more work.
    display_code TEXT NOT NULL CHECK (display_code ~ '^pr-[a-f0-9]{64}$'),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE trial_campaign_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_id UUID NOT NULL,
    actor_id UUID NOT NULL REFERENCES accounts(id),
    action TEXT NOT NULL CHECK (action IN ('started','stopped')),
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);
