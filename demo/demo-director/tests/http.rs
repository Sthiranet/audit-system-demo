//! HTTP-level smoke tests: routes, JSON shapes and error bodies, through the real router.

use std::path::Path;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use demo_director::World;
use demo_director::api::app;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn call(method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let router = app(World::shared(), Path::new("/nonexistent"));
    call_on(router, method, uri, body).await
}

async fn call_on(router: axum::Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = router.oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn state_has_the_shape_the_ui_reads() {
    let (status, s) = call("GET", "/api/state", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(s["subs"].as_array().unwrap().len(), 3);
    let s1 = &s["subs"][0];
    for k in
        ["id", "name", "region", "db", "currency", "pending", "lastSeq", "lastHead", "storeCount", "members", "hqCopy"]
    {
        assert!(s1.get(k).is_some(), "subs[0].{k}");
    }
    assert_eq!(s1["lastSeq"], 3);
    assert_eq!(s["auditor"]["enabled"], false);
    assert!(s["activity"].as_array().unwrap().len() == 1);
}

#[tokio::test]
async fn seal_and_batch_detail() {
    let world = World::shared();
    let router = app(world.clone(), Path::new("/nonexistent"));
    let (_, p) = call_on(router.clone(), "POST", "/api/capture/S1", Some(json!({ "count": 10 }))).await;
    assert_eq!(p["pending"].as_array().unwrap().len(), 10);
    let row = &p["pending"][0];
    assert!(row["label"].is_string() && row["raw"]["source"]["connector"] == "postgresql");
    let (status, d) = call_on(router.clone(), "POST", "/api/seal/S1", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(d["seq"], 4);
    assert_eq!(d["batch"]["items"].as_array().unwrap().len(), 10);
    assert!(d["batch"]["tree"]["left"]["hash"].is_string());
    assert_eq!(d["anchor"]["signatories"], json!(["S1", "HQ"]));
    let (status, _) = call_on(router, "GET", "/api/batch/S1/2", None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn trail_tamper_verify_over_http() {
    let world = World::shared();
    let router = app(world.clone(), Path::new("/nonexistent"));
    let (_, t) = call_on(router.clone(), "GET", "/api/trail/sub/S1", None).await;
    assert_eq!(t["where"], "sub");
    let id = t["rows"][0]["id"].as_str().unwrap().to_string();
    let (status, r) = call_on(
        router.clone(),
        "POST",
        "/api/tamper",
        Some(json!({ "where": "sub", "chain": "S1", "eventId": id, "mode": "edit" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    call_on(router.clone(), "POST", "/api/push/S1", None).await;
    let (_, v) = call_on(router, "POST", "/api/verify", Some(json!({ "verifier": "HQ", "chain": "S1" }))).await;
    assert_eq!(v["ok"], false);
    assert_eq!(v["firstBadSeq"], 1);
    assert_eq!(v["verifier"], "HQ");
    assert!(v["batches"][0]["leafIssues"][0]["eventId"].is_string());
}

#[tokio::test]
async fn errors_are_json() {
    let (status, e) = call("POST", "/api/seal/S9", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(e["error"], "Unknown subsidiary S9");
    let (status, e) = call("POST", "/api/verify", Some(json!({ "verifier": "AUDITOR", "chain": "S1" }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(e["error"], "Add the auditor to the network first");
    let (status, e) = call("GET", "/api/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(e["error"], "Not found");
    let router = app(World::shared(), Path::new("/nonexistent"));
    let req =
        Request::post("/api/tamper").header("content-type", "application/json").body(Body::from("{oops")).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rewrite_is_rejected() {
    let (status, r) =
        call("POST", "/api/ledger/rewrite", Some(json!({ "actor": "HQ", "chain": "S1", "seq": 2 }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(r["ok"], false);
    assert_eq!(r["missing"], json!(["S1"]));
}
