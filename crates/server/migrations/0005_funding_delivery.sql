-- Delivery may be retried after a lost dispatcher reply. The invoice remains
-- the idempotency key; an acknowledgment is not proof of completed service.
ALTER TABLE payment_funding_events
    ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (delivery_state IN ('pending','delivered','needs_review')),
    ADD COLUMN delivery_token UUID,
    ADD COLUMN delivery_until TIMESTAMPTZ,
    ADD COLUMN next_delivery_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN delivery_error TEXT,
    ADD COLUMN delivery_attempted_at TIMESTAMPTZ,
    ADD CONSTRAINT funding_delivery_claim CHECK ((delivery_token IS NULL) = (delivery_until IS NULL));
UPDATE payment_funding_events SET delivery_state = 'delivered' WHERE consumed_at IS NOT NULL;
ALTER TABLE payment_funding_events ADD CONSTRAINT funding_delivery_consumed
    CHECK ((delivery_state = 'delivered') = (consumed_at IS NOT NULL));
CREATE INDEX payment_funding_delivery ON payment_funding_events(next_delivery_at)
    WHERE delivery_state = 'pending';
