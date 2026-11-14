//! Cache fingerprinted build assets; every other response stays uncached.
use axum::{
    extract::Request,
    http::{HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::Response,
};

#[derive(Clone)]
struct VersionedAsset;

fn asset_type(path: &str) -> Option<&'static str> {
    let (stem, extension) = path.strip_prefix("/assets/")?.rsplit_once('.')?;
    // Vite's default filenames end in an eight-character hash. Dashes and
    // underscores can occur inside the hash, including at its final character.
    let bytes = stem.as_bytes();
    if bytes.len() < 10
        || !bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return None;
    }
    let (name, hash) = bytes.split_at(bytes.len() - 8);
    if !name.ends_with(b"-")
        || !hash
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return None;
    }
    match extension {
        "js" => Some("text/javascript"),
        "css" => Some("text/css"),
        _ => None,
    }
}

/// Only the static file service can mark a response cacheable. A filename-like
/// API path or a fallback HTML/error response must never acquire this policy.
pub(crate) async fn mark_versioned(request: Request, next: Next) -> Response {
    let expected_type = matches!(*request.method(), Method::GET | Method::HEAD)
        .then(|| asset_type(request.uri().path()))
        .flatten();
    let mut response = next.run(request).await;
    if let Some(expected_type) = expected_type {
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next());
        let served_asset = matches!(
            response.status(),
            StatusCode::OK | StatusCode::PARTIAL_CONTENT
        ) && content_type == Some(expected_type);
        if (served_asset || response.status() == StatusCode::NOT_MODIFIED)
            && !response.headers().contains_key(header::SET_COOKIE)
        {
            response.extensions_mut().insert(VersionedAsset);
        }
    }
    response
}

pub(crate) fn cache_control(response: &Response) -> Option<HeaderValue> {
    Some(HeaderValue::from_static(
        if response.extensions().get::<VersionedAsset>().is_some() {
            "public, max-age=31536000, immutable"
        } else {
            "no-store"
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body};
    use http_body_util::BodyExt;
    use std::{fs, path::PathBuf};
    use tower::ServiceExt;

    const CACHED: &str = "public, max-age=31536000, immutable";

    struct Site {
        root: PathBuf,
        app: Router,
    }

    impl Site {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("patchriot-assets-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("assets")).unwrap();
            for (path, content) in [
                (
                    "index.html",
                    "<!doctype html><title>Patchriot fixture</title>",
                ),
                ("assets/index-ABcd1234.js", "console.log('fixture');"),
                ("assets/runtime-DLMaRju-.js", "export const runtime = true;"),
                (
                    "assets/tslib.es6-Cna8skA-.js",
                    "export const helper = true;",
                ),
                ("assets/index-AB_cd-12.css", "body { color: blue; }"),
                ("assets/index.js", "console.log('unversioned');"),
                ("assets/index-short.css", "body { color: red; }"),
                ("assets/index-ABcd1234.html", "<!doctype html>"),
                ("index-ABcd1234.js", "console.log('outside assets');"),
            ] {
                fs::write(root.join(path), content).unwrap();
            }
            let config = crate::Config::new(
                "https://patchriot.example".into(),
                "http://127.0.0.1:1".into(),
                "x".repeat(32),
                Some(root.clone()),
            )
            .unwrap();
            let pool = sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://127.0.0.1:1/unused")
                .unwrap();
            let app = crate::router(crate::AppState::new(pool, config).unwrap());
            Self { root, app }
        }

        async fn request(&self, method: &str, path: &str, headers: &[(&str, &str)]) -> Response {
            let mut request = Request::builder().method(method).uri(path);
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            self.app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap()
        }
    }

    impl Drop for Site {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[tokio::test]
    async fn caches_versioned_get_and_head_without_dropping_security_headers() {
        let site = Site::new();
        for method in ["GET", "HEAD"] {
            for path in [
                "/assets/index-ABcd1234.js",
                "/assets/runtime-DLMaRju-.js",
                "/assets/tslib.es6-Cna8skA-.js",
                "/assets/index-AB_cd-12.css?build=1",
            ] {
                let response = site.request(method, path, &[]).await;
                assert_eq!(response.status(), StatusCode::OK, "{method} {path}");
                assert_eq!(response.headers()[header::CACHE_CONTROL], CACHED, "{path}");
                assert_eq!(
                    response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                    "nosniff"
                );
                assert!(
                    response
                        .headers()
                        .contains_key(header::CONTENT_SECURITY_POLICY)
                );
                let bytes = response.into_body().collect().await.unwrap().to_bytes();
                assert_eq!(bytes.is_empty(), method == "HEAD");
            }
        }
    }

    #[tokio::test]
    async fn keeps_shell_api_private_routes_and_unversioned_files_uncached() {
        let site = Site::new();
        for path in [
            "/",
            "/index.html",
            "/login",
            "/api/health",
            "/api/session",
            "/api/analytics",
            "/api/reviews/00000000-0000-0000-0000-000000000000",
            "/api/assets/index-ABcd1234.js",
            "/assets/index.js",
            "/assets/index-short.css",
            "/assets/index-ABcd1234.html",
            "/index-ABcd1234.js",
        ] {
            let response = site.request("GET", path, &[]).await;
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store",
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn missing_assets_and_unsupported_methods_are_not_cached() {
        let site = Site::new();
        let response = site
            .request("GET", "/assets/missing-ABcd1234.js", &[])
            .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(body.starts_with(b"<!doctype html>"));

        let response = site.request("POST", "/assets/index-ABcd1234.js", &[]).await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn preserves_conditional_and_range_requests() {
        let site = Site::new();
        let path = "/assets/index-ABcd1234.js";
        let initial = site.request("GET", path, &[]).await;
        let modified = initial.headers()[header::LAST_MODIFIED].to_str().unwrap();
        let conditional = site
            .request("GET", path, &[("if-modified-since", modified)])
            .await;
        assert_eq!(conditional.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(conditional.headers()[header::CACHE_CONTROL], CACHED);

        let range = site.request("GET", path, &[("range", "bytes=0-6")]).await;
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range.headers()[header::CACHE_CONTROL], CACHED);
        assert_eq!(
            range.into_body().collect().await.unwrap().to_bytes(),
            "console"
        );

        let invalid_range = site.request("GET", path, &[("range", "bytes=9999-")]).await;
        assert_eq!(invalid_range.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(invalid_range.headers()[header::CACHE_CONTROL], "no-store");
    }
}
