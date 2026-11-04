//! One immutable assessment target. Snapshot, source and live IDs cannot be mixed.
use patchriot_protocol::{FixtureScenario, ReviewView, website_reviews::CreateWebsiteReview};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewTarget {
    Website(Uuid),
    Source(Uuid),
    Pentest(Uuid),
}
impl ReviewTarget {
    pub fn from_ids(
        site: Option<Uuid>,
        source: Option<Uuid>,
        pentest: Option<Uuid>,
    ) -> Option<Self> {
        match (
            site.filter(|id| !id.is_nil()),
            source.filter(|id| !id.is_nil()),
            pentest.filter(|id| !id.is_nil()),
        ) {
            (Some(id), None, None) if source.is_none() && pentest.is_none() => {
                Some(Self::Website(id))
            }
            (None, Some(id), None)
                if (site.is_none() || site == Some(Uuid::nil())) && pentest.is_none() =>
            {
                Some(Self::Source(id))
            }
            (None, None, Some(id))
                if (site.is_none() || site == Some(Uuid::nil())) && source.is_none() =>
            {
                Some(Self::Pentest(id))
            }
            _ => None,
        }
    }
    pub fn site_id(self) -> Option<Uuid> {
        match self {
            Self::Website(id) => Some(id),
            _ => None,
        }
    }
    pub fn source_id(self) -> Option<Uuid> {
        match self {
            Self::Source(id) => Some(id),
            _ => None,
        }
    }
    pub fn pentest_id(self) -> Option<Uuid> {
        match self {
            Self::Pentest(id) => Some(id),
            _ => None,
        }
    }
    pub fn consent_body(
        self,
        consent: &CreateWebsiteReview,
    ) -> Result<serde_json::Value, serde_json::Error> {
        match self {
            Self::Pentest(_) => serde_json::to_value(
                patchriot_protocol::pentests::StartPentest::from(consent.clone()),
            ),
            _ => serde_json::to_value(consent),
        }
    }
    pub fn path(self) -> String {
        match self {
            Self::Website(id) => format!("/internal/site-checks/{id}"),
            Self::Source(id) => format!("/internal/sources/{id}"),
            Self::Pentest(id) => format!("/internal/pentests/{id}"),
        }
    }
    pub fn matches(self, view: &ReviewView, consent: &CreateWebsiteReview) -> bool {
        if view.id.is_nil()
            || view.request_id != consent.request_id
            || match self {
                Self::Pentest(_) => view
                    .pentest
                    .as_ref()
                    .is_none_or(|c| c.review_policy != consent.review_policy),
                _ => !consent.review_policy.is_legacy(),
            }
        {
            return false;
        }
        let material = match self {
            Self::Website(id)
                if view.mode == "website_agent"
                    && view.scenario == FixtureScenario::WebsiteSnapshotV1
                    && view.source.is_none()
                    && view.pentest.is_none() =>
            {
                view.website
                    .as_ref()
                    .map(|c| (id == c.site_check_id, &c.snapshot_sha256, &c.reviewers))
            }
            Self::Source(id)
                if view.mode == "source_agent"
                    && view.scenario == FixtureScenario::SourceBundleV1
                    && view.website.is_none()
                    && view.pentest.is_none() =>
            {
                view.source
                    .as_ref()
                    .map(|c| (id == c.source_id, &c.snapshot_sha256, &c.reviewers))
            }
            Self::Pentest(id)
                if view.mode == "pentest_agent"
                    && view.scenario == FixtureScenario::LiveHttpV1
                    && view.website.is_none()
                    && view.source.is_none()
                    && consent.accepts_operator_access
                    && consent.accepts_provider_access =>
            {
                view.pentest
                    .as_ref()
                    .map(|c| (id == c.pentest_id, &c.scope_sha256, &c.reviewers))
            }
            _ => None,
        };
        material.is_some_and(|(id, hash, people)| {
            id && *hash == consent.snapshot_sha256
                && people.iter().map(|r| r.device_id).collect::<Vec<_>>() == consent.device_ids
        })
    }
}
