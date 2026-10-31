-- Public research is deliberately separate from private customer reviews.
-- Editing a draft never replaces the approved public snapshot.
CREATE TABLE incidents (
    id UUID PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    published_content JSONB,
    published_revision INTEGER,
    published_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (published_content IS NULL AND published_revision IS NULL AND published_at IS NULL)
        OR (published_content IS NOT NULL AND published_revision IS NOT NULL AND published_at IS NOT NULL
            AND published_revision BETWEEN 1 AND revision)
    )
);
CREATE INDEX incidents_public ON incidents (published_at DESC, id) WHERE published_content IS NOT NULL;

CREATE TABLE incident_edits (
    incident_id UUID NOT NULL REFERENCES incidents(id),
    revision INTEGER NOT NULL,
    actor_id UUID NOT NULL REFERENCES accounts(id),
    action TEXT NOT NULL CHECK (action IN ('draft_saved', 'published', 'withdrawn')),
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (incident_id, revision)
);
