mod api;
mod middleware;

use axum::{middleware as mw, routing::get, Router};

#[derive(Clone)]
pub struct AppState {
    pub name: String,
}

async fn health() -> &'static str {
    "ok"
}

fn app(state: AppState) -> Router {
    let admin = Router::new().route("/stats", get(api::admin::stats));
    Router::new()
        .route("/health", get(health))
        .nest("/api", api::routes())
        .nest("/admin", admin.layer(mw::from_fn(middleware::require_admin)))
        .merge(api::public::routes())
        .layer(mw::from_fn(middleware::log_requests))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    let state = AppState { name: "demo".to_string() };
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app(state)).await.unwrap();
}
