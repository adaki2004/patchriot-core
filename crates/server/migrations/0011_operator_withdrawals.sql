-- Reservations subtract from spendable earnings immediately. Unknown chain or
-- provider outcomes stay reserved; a timeout never creates a second payment.
CREATE TABLE operator_claims (
    id UUID PRIMARY KEY,
    operator_id UUID NOT NULL REFERENCES accounts(id),
    amount BIGINT NOT NULL CHECK (amount >= 10000000),
    destination_asset TEXT NOT NULL,
    recipient TEXT NOT NULL,
    treasury TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('preparing','quoted','queued','signed','paid','cancelled','needs_review')),
    quote_request JSONB,
    quote JSONB,
    deposit_address TEXT UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    quote_token UUID,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (state NOT IN ('quoted','queued','signed','paid') OR (quote IS NOT NULL AND quote_request IS NOT NULL AND deposit_address IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_operator_claim ON operator_claims(operator_id)
    WHERE state NOT IN ('paid','cancelled');
CREATE INDEX operator_claim_history ON operator_claims(operator_id,created_at DESC);

CREATE TABLE payout_transactions (
    claim_id UUID PRIMARY KEY REFERENCES operator_claims(id),
    chain_id BIGINT NOT NULL CHECK (chain_id=8453),
    sender TEXT NOT NULL,
    nonce BIGINT NOT NULL CHECK (nonce>=0),
    tx_hash TEXT NOT NULL UNIQUE,
    signed_bytes TEXT NOT NULL CHECK (length(signed_bytes) BETWEEN 10 AND 4096),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(chain_id,sender,nonce)
);
CREATE TABLE payout_receipts (
    claim_id UUID PRIMARY KEY REFERENCES operator_claims(id),
    gross_amount BIGINT NOT NULL CHECK (gross_amount>=10000000),
    received_amount BIGINT NOT NULL CHECK (received_amount>0),
    source_tx TEXT NOT NULL UNIQUE,
    destination_txs JSONB NOT NULL,
    provider_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_payout_transaction BEFORE UPDATE OR DELETE ON payout_transactions
    FOR EACH ROW EXECUTE FUNCTION payment_ledger_is_append_only();
CREATE TRIGGER immutable_payout_receipt BEFORE UPDATE OR DELETE ON payout_receipts
    FOR EACH ROW EXECUTE FUNCTION payment_ledger_is_append_only();

CREATE FUNCTION protect_claim_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.operator_id,NEW.amount,NEW.destination_asset,NEW.recipient,NEW.treasury,NEW.expires_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.operator_id,OLD.amount,OLD.destination_asset,OLD.recipient,OLD.treasury,OLD.expires_at)
        OR (OLD.quote IS NOT NULL AND ROW(NEW.quote,NEW.quote_request,NEW.deposit_address) IS DISTINCT FROM ROW(OLD.quote,OLD.quote_request,OLD.deposit_address))
        OR (OLD.state IN ('paid','cancelled') AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'saved withdrawal terms cannot change'; END IF;
    IF NEW.state='cancelled' AND EXISTS(SELECT 1 FROM payout_transactions WHERE claim_id=NEW.id)
    THEN RAISE EXCEPTION 'signed withdrawal cannot be released'; END IF;
    IF NEW.state='paid' AND NOT EXISTS(SELECT 1 FROM payout_receipts WHERE claim_id=NEW.id AND gross_amount=NEW.amount)
    THEN RAISE EXCEPTION 'withdrawal requires a receipt'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protected_claim_terms BEFORE UPDATE ON operator_claims
    FOR EACH ROW EXECUTE FUNCTION protect_claim_terms();
CREATE TRIGGER no_claim_delete BEFORE DELETE ON operator_claims
    FOR EACH ROW EXECUTE FUNCTION payment_ledger_is_append_only();

-- One global signing lane. It remains occupied until a final result is known,
-- so restart or nonce uncertainty cannot put another payment behind a gap.
CREATE TABLE treasury_lane (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    claim_id UUID UNIQUE REFERENCES operator_claims(id)
);
INSERT INTO treasury_lane(id) VALUES(true);
CREATE TABLE treasury_observations (
    id BIGSERIAL PRIMARY KEY,
    treasury TEXT NOT NULL,
    balance BIGINT NOT NULL CHECK (balance>=0),
    liabilities BIGINT NOT NULL CHECK (liabilities>=0),
    buffer BIGINT NOT NULL CHECK (buffer>0),
    block_number BIGINT NOT NULL,
    sufficient BOOLEAN NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
