//! Authenticated source intake. Source text leaves only as JSON attachments or
//! authenticated dispatcher requests; the web server never renders or runs it.
use crate::{ApiError, AppState, auth, gateway};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use patchriot_protocol::{CancelReview, ReviewView, sources::*};
use reqwest::Method;
use uuid::Uuid;

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<SourceUploadView>>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    gateway::request_with_limit::<(), _>(
        &state,
        Method::GET,
        "/internal/sources",
        Some(&session),
        None,
        1024 * 1024,
    )
    .await
}
pub async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<SourceUploadView>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    gateway::request::<(), _>(
        &state,
        Method::GET,
        &format!("/internal/sources/{id}"),
        Some(&session),
        None,
    )
    .await
}
pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateSourceUpload>,
) -> Result<Json<SourceUploadView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    input.bundle().map_err(ApiError::bad)?;
    gateway::request(
        &state,
        Method::POST,
        "/internal/sources",
        Some(&session),
        Some(&input),
    )
    .await
}
pub async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<DecideSourceUpload>,
) -> Result<Json<SourceUploadView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    if session.role != "admin" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admin_required"));
    }
    gateway::request(
        &state,
        Method::POST,
        &format!("/internal/sources/{id}/decision"),
        Some(&session),
        Some(&input),
    )
    .await
}
pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<CancelReview>,
) -> Result<Json<SourceUploadView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    gateway::request(
        &state,
        Method::POST,
        &format!("/internal/sources/{id}/delete"),
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
    let Json(bundle): Json<SourceBundle> = gateway::request_with_limit::<(), _>(
        &state,
        Method::GET,
        &format!("/internal/sources/{id}/evidence"),
        Some(&session),
        None,
        MAX_SOURCE_BODY_BYTES,
    )
    .await?;
    let bytes = serde_json::to_vec(&bundle).map_err(|_| ApiError::bad("invalid_evidence"))?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/json; charset=utf-8".to_owned(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"patchriot-source-{id}.json\""),
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
) -> Result<Json<SourceReviewPlan>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    gateway::request::<(), _>(
        &state,
        Method::GET,
        &format!("/internal/sources/{id}/review-plan"),
        Some(&session),
        None,
    )
    .await
}
pub async fn create_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<CreateSourceReview>,
) -> Result<Json<ReviewView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    use crate::payments::access::ReviewAccess;
    match state.review_access {
        ReviewAccess::FreePilot => {}
        ReviewAccess::Coupons => {
            return Err(ApiError::new(
                StatusCode::PAYMENT_REQUIRED,
                "review_code_required",
            ));
        }
        ReviewAccess::Paid(_) => {
            return Err(ApiError::new(
                StatusCode::PAYMENT_REQUIRED,
                "payment_required",
            ));
        }
        ReviewAccess::Closed => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "checkout_unavailable",
            ));
        }
    }
    gateway::request(
        &state,
        Method::POST,
        &format!("/internal/sources/{id}/review"),
        Some(&session),
        Some(&input),
    )
    .await
}
