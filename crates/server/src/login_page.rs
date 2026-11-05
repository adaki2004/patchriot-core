//! A real HTML password form for users and scoped HTTP form discovery.
//! It shares the JSON login's password checks, rate limits and session cookies.
use crate::{ApiError, AppState, access};
use axum::{
    Extension, Form, Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use std::net::SocketAddr;

pub(crate) async fn page() -> Html<&'static str> {
    Html(include_str!("login_page.html"))
}

pub(crate) async fn styles() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("login_page.css"),
    )
}

pub(crate) async fn submit(
    state: State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Form(input): Form<access::Login>,
) -> Result<Response, ApiError> {
    let mut response = access::login(state, peer, headers, Json(input)).await?;
    // Keep the exact session cookie from the normal login handler. The redirect
    // is fixed, not supplied by the request or target page.
    *response.status_mut() = StatusCode::SEE_OTHER;
    response
        .headers_mut()
        .insert(header::LOCATION, HeaderValue::from_static("/#/account"));
    Ok(response)
}
