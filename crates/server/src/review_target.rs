//! One immutable piece of material. Website and source IDs are never interchangeable.
use patchriot_protocol::{FixtureScenario, ReviewView, website_reviews::CreateWebsiteReview};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewTarget {
    Website(Uuid),
    Source(Uuid),
}
impl ReviewTarget {
    pub fn from_ids(site: Option<Uuid>, source: Option<Uuid>) -> Option<Self> {
        match (
            site.filter(|id| !id.is_nil()),
            source.filter(|id| !id.is_nil()),
        ) {
            (Some(id), None) if source.is_none() => Some(Self::Website(id)),
            (None, Some(id)) if site.is_none() || site == Some(Uuid::nil()) => {
                Some(Self::Source(id))
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
    pub fn path(self) -> String {
        match self {
            Self::Website(id) => format!("/internal/site-checks/{id}"),
            Self::Source(id) => format!("/internal/sources/{id}"),
        }
    }
    pub fn matches(self, view: &ReviewView, consent: &CreateWebsiteReview) -> bool {
        if view.id.is_nil() || view.request_id != consent.request_id {
            return false;
        }
        let material = match self {
            Self::Website(id)
                if view.mode == "website_agent"
                    && view.scenario == FixtureScenario::WebsiteSnapshotV1
                    && view.source.is_none() =>
            {
                view.website
                    .as_ref()
                    .map(|c| (id == c.site_check_id, &c.snapshot_sha256, &c.reviewers))
            }
            Self::Source(id)
                if view.mode == "source_agent"
                    && view.scenario == FixtureScenario::SourceBundleV1
                    && view.website.is_none() =>
            {
                view.source
                    .as_ref()
                    .map(|c| (id == c.source_id, &c.snapshot_sha256, &c.reviewers))
            }
            _ => None,
        };
        material.is_some_and(|(id, hash, people)| {
            id && *hash == consent.snapshot_sha256
                && people.iter().map(|r| r.device_id).collect::<Vec<_>>() == consent.device_ids
        })
    }
}
