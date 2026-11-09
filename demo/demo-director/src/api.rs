//! HTTP API (axum), live updates over server-sent events, and the OpenAPI spec the TypeScript
//! client is generated from. Errors are JSON `{ "error": "…" }` with the action's status code.

use std::convert::Infallible;
use std::path::Path;

use axum::body::Bytes;
use axum::extract::{FromRequest, Path as UrlPath, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use sthira_ledger::ArchiveAttempt;
use tokio_stream::{Stream, StreamExt, wrappers::WatchStream};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use utoipa::OpenApi;

use crate::views::*;
use crate::world::{DemoError, Shared, set_auto};

type ApiResult<T> = Result<Json<T>, DemoError>;

impl IntoResponse for DemoError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(ErrorBody { error: self.message })).into_response()
    }
}

/// A JSON body that may be empty (treated as `{}`), with JSON errors on bad input.
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned + Default> FromRequest<S> for JsonBody<T> {
    type Rejection = DemoError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state).await.map_err(|_| DemoError::bad("Invalid JSON body"))?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Self(T::default()));
        }
        serde_json::from_slice(&bytes).map(Self).map_err(|_| DemoError::bad("Invalid JSON body"))
    }
}

fn lock(s: &Shared) -> std::sync::MutexGuard<'_, crate::World> {
    s.lock().expect("world lock")
}

#[utoipa::path(get, path = "/api/state", responses((status = 200, body = StateView)))]
async fn get_state(State(s): State<Shared>) -> Json<StateView> {
    Json(lock(&s).state())
}

#[utoipa::path(get, path = "/api/pending/{id}", params(("id" = String, Path)),
    responses((status = 200, body = PendingView), (status = 404, body = ErrorBody)))]
async fn get_pending(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<PendingView> {
    lock(&s).pending(&id).map(Json)
}

#[utoipa::path(post, path = "/api/capture/{id}", params(("id" = String, Path)), request_body = CaptureRequest,
    responses((status = 200, body = PendingView), (status = 404, body = ErrorBody)))]
async fn capture(
    State(s): State<Shared>,
    UrlPath(id): UrlPath<String>,
    JsonBody(b): JsonBody<CaptureRequest>,
) -> ApiResult<PendingView> {
    lock(&s).capture(&id, b.count).map(Json)
}

#[utoipa::path(post, path = "/api/seal/{id}", params(("id" = String, Path)),
    responses((status = 200, body = BatchDetail), (status = 404, body = ErrorBody), (status = 409, body = ErrorBody)))]
async fn seal(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<BatchDetail> {
    lock(&s).seal(&id).map(Json)
}

#[utoipa::path(get, path = "/api/batch/{id}/{seq}", params(("id" = String, Path), ("seq" = u64, Path)),
    responses((status = 200, body = BatchDetail), (status = 404, body = ErrorBody)))]
async fn batch(State(s): State<Shared>, UrlPath((id, seq)): UrlPath<(String, String)>) -> ApiResult<BatchDetail> {
    let seq = seq.parse().map_err(|_| DemoError::not_found("Not found"))?;
    lock(&s).batch_detail(&id, seq).map(Json)
}

#[utoipa::path(get, path = "/api/ledger/{party}", params(("party" = String, Path)),
    responses((status = 200, body = LedgerView), (status = 404, body = ErrorBody)))]
async fn ledger(State(s): State<Shared>, UrlPath(party): UrlPath<String>) -> ApiResult<LedgerView> {
    lock(&s).ledger_view(&party).map(Json)
}

#[utoipa::path(post, path = "/api/ledger/rewrite", request_body = RewriteRequest,
    responses((status = 200, body = ArchiveAttempt), (status = 400, body = ErrorBody)))]
async fn rewrite(State(s): State<Shared>, JsonBody(b): JsonBody<RewriteRequest>) -> ApiResult<ArchiveAttempt> {
    lock(&s).rewrite(&b.actor, &b.chain, b.seq).map(Json)
}

#[utoipa::path(get, path = "/api/trail/{where}/{chain}", params(("where" = TrailHolder, Path), ("chain" = String, Path)),
    responses((status = 200, body = TrailView), (status = 400, body = ErrorBody), (status = 404, body = ErrorBody)))]
async fn trail(State(s): State<Shared>, UrlPath((held_in, chain)): UrlPath<(String, String)>) -> ApiResult<TrailView> {
    lock(&s).trail(&held_in, &chain).map(Json)
}

#[utoipa::path(post, path = "/api/push/{id}", params(("id" = String, Path)),
    responses((status = 200, body = PushResult), (status = 404, body = ErrorBody)))]
async fn push(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<PushResult> {
    lock(&s).push(&id).map(Json)
}

#[utoipa::path(post, path = "/api/tamper", request_body = TamperRequest,
    responses((status = 200, body = TamperResult), (status = 400, body = ErrorBody), (status = 404, body = ErrorBody)))]
async fn tamper(State(s): State<Shared>, JsonBody(b): JsonBody<TamperRequest>) -> ApiResult<TamperResult> {
    lock(&s).tamper(&b).map(Json)
}

#[utoipa::path(post, path = "/api/verify", request_body = VerifyRequest,
    responses((status = 200, body = VerifyResponse), (status = 400, body = ErrorBody)))]
async fn verify(State(s): State<Shared>, JsonBody(b): JsonBody<VerifyRequest>) -> ApiResult<VerifyResponse> {
    lock(&s).verify(&b.verifier, &b.chain).map(Json)
}

#[utoipa::path(post, path = "/api/auditor", responses((status = 200, body = StateView)))]
async fn auditor(State(s): State<Shared>) -> ApiResult<StateView> {
    lock(&s).add_auditor().map(Json)
}

#[utoipa::path(post, path = "/api/auto", request_body = AutoRequest, responses((status = 200, body = StateView)))]
async fn auto(State(s): State<Shared>, JsonBody(b): JsonBody<AutoRequest>) -> Json<StateView> {
    Json(set_auto(&s, b.on))
}

#[utoipa::path(post, path = "/api/reset", responses((status = 200, body = StateView)))]
async fn reset(State(s): State<Shared>) -> Json<StateView> {
    Json(lock(&s).reset())
}

/// Server-sent events: a `version` event carrying the state version whenever it changes.
#[utoipa::path(get, path = "/api/stream",
    responses((status = 200, description = "SSE stream of `version` events", content_type = "text/event-stream", body = String)))]
async fn stream(State(s): State<Shared>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = lock(&s).subscribe();
    let events = WatchStream::new(rx).map(|v| Ok(Event::default().event("version").data(v.to_string())));
    Sse::new(events).keep_alive(KeepAlive::default())
}

async fn api_not_found() -> DemoError {
    DemoError::not_found("Not found")
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Sthiranet demo-director API",
        description = "Presentation demo: group audit trail anchored on a (simulated) Canton ledger"
    ),
    paths(
        get_state,
        get_pending,
        capture,
        seal,
        batch,
        ledger,
        rewrite,
        trail,
        push,
        tamper,
        verify,
        auditor,
        auto,
        reset,
        stream
    )
)]
pub struct ApiDoc;

/// The `/api` routes alone.
pub fn api_router(state: Shared) -> Router {
    Router::new()
        .route("/state", get(get_state))
        .route("/pending/{id}", get(get_pending))
        .route("/capture/{id}", post(capture))
        .route("/seal/{id}", post(seal))
        .route("/batch/{id}/{seq}", get(batch))
        .route("/ledger/rewrite", post(rewrite))
        .route("/ledger/{party}", get(ledger))
        .route("/trail/{where}/{chain}", get(trail))
        .route("/push/{id}", post(push))
        .route("/tamper", post(tamper))
        .route("/verify", post(verify))
        .route("/auditor", post(auditor))
        .route("/auto", post(auto))
        .route("/reset", post(reset))
        .route("/stream", get(stream))
        .fallback(api_not_found)
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        .with_state(state)
}

/// The API under `/api`, plus the built UI from `ui_dist` (single-page app: unknown paths serve index.html).
pub fn app(state: Shared, ui_dist: &Path) -> Router {
    let spa = ServeDir::new(ui_dist).fallback(ServeFile::new(ui_dist.join("index.html")));
    Router::new().nest("/api", api_router(state)).fallback_service(spa)
}
