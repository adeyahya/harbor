//! Serves the compiled React app embedded at build time, falling back to
//! `index.html` so client-side routes work on reload.

use axum::{
    body::Body,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../frontend/dist"]
struct Assets;

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if let Some(res) = file(path) {
        return res;
    }
    // Unknown asset files are real 404s; anything else is an app route.
    if path.starts_with("assets/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    file("index.html").unwrap_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "frontend not built: run `pnpm build` in frontend/ and rebuild the backend",
        )
            .into_response()
    })
}

fn file(path: &str) -> Option<Response> {
    if path.is_empty() {
        return None;
    }
    let asset = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Vite fingerprints everything under assets/, so it can be cached forever.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Some(
        Response::builder()
            .header(header::CONTENT_TYPE, mime.as_ref())
            .header(header::CACHE_CONTROL, cache)
            .body(Body::from(asset.data.into_owned()))
            .unwrap(),
    )
}
