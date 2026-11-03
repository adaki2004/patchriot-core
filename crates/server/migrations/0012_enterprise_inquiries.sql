-- Contact requests stay in core. They never authorize a test or reach agents.
CREATE TABLE enterprise_inquiries (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
    organization TEXT NOT NULL CHECK (length(organization) BETWEEN 1 AND 160),
    message TEXT NOT NULL CHECK (length(message) BETWEEN 20 AND 3000),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','handled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES accounts(id)
);
CREATE INDEX enterprise_inquiries_inbox ON enterprise_inquiries(state,created_at DESC,id);
