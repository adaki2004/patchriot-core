use crate::{ApiError, AppState, auth, gateway};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use patchriot_protocol::websites::{
    CancelSiteCheck, CreateSiteCheck, DecideSiteCheck, SiteCheckView, WebsiteComparison,
    WebsiteSnapshot,
};
use patchriot_protocol::{
    ReviewView,
    website_reviews::{CreateWebsiteReview, WebsiteReviewPlan},
};
use reqwest::Method;
use uuid::Uuid;

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<SiteCheckView>>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    gateway::request::<(), _>(
        &state,
        Method::GET,
        "/internal/site-checks",
        Some(&session),
        None,
    )
    .await
}

pub async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<SiteCheckView>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    gateway::request::<(), _>(
        &state,
        Method::GET,
        &format!("/internal/site-checks/{id}"),
        Some(&session),
        None,
    )
    .await
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateSiteCheck>,
) -> Result<Json<SiteCheckView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    gateway::request(
        &state,
        Method::POST,
        "/internal/site-checks",
        Some(&session),
        Some(&input),
    )
    .await
}

pub async fn compare(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, baseline_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<WebsiteComparison>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    gateway::request_with_limit::<(), _>(
        &state,
        Method::GET,
        &format!("/internal/site-checks/{id}/compare/{baseline_id}"),
        Some(&session),
        None,
        1024 * 1024,
    )
    .await
}

pub async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<DecideSiteCheck>,
) -> Result<Json<SiteCheckView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    if session.role != "admin" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admin_required"));
    }
    gateway::request(
        &state,
        Method::POST,
        &format!("/internal/site-checks/{id}/decision"),
        Some(&session),
        Some(&input),
    )
    .await
}

pub async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<CancelSiteCheck>,
) -> Result<Json<SiteCheckView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    gateway::request(
        &state,
        Method::POST,
        &format!("/internal/site-checks/{id}/cancel"),
        Some(&session),
        Some(&input),
    )
    .await
}

pub async fn evidence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    let Json(snapshot): Json<WebsiteSnapshot> = gateway::request_with_limit::<(), _>(
        &state,
        Method::GET,
        &format!("/internal/site-checks/{id}/evidence"),
        Some(&session),
        None,
        5 * 1024 * 1024,
    )
    .await?;
    let bytes = serde_json::to_vec(&snapshot).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "evidence_encoding_failed",
        )
    })?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/json; charset=utf-8".to_owned(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"patchriot-site-{id}.json\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

pub async fn review_plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<WebsiteReviewPlan>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    gateway::request::<(), _>(
        &state,
        Method::GET,
        &format!("/internal/site-checks/{id}/review-plan"),
        Some(&session),
        None,
    )
    .await
}

pub async fn create_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<CreateWebsiteReview>,
) -> Result<Json<ReviewView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    match state.review_access {
        crate::payments::access::ReviewAccess::FreePilot => {}
        crate::payments::access::ReviewAccess::Paid(_) => {
            return Err(ApiError::new(
                StatusCode::PAYMENT_REQUIRED,
                "payment_required",
            ));
        }
        crate::payments::access::ReviewAccess::Closed => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "checkout_unavailable",
            ));
        }
    }
    gateway::request(
        &state,
        Method::POST,
        &format!("/internal/site-checks/{id}/review"),
        Some(&session),
        Some(&input),
    )
    .await
}
