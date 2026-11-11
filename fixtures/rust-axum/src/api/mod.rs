pub mod admin;
pub mod public;
pub mod users;

use axum::{routing::get, Router};

pub fn routes() -> Router {
    Router::new()
        .route("/status", get(status))
        .nest("/users", users::routes())
}

async fn status() -> &'static str {
    "up"
}
