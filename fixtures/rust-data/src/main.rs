mod db;
mod entity;
mod schema;

use axum::{routing::{get, post}, Router};

fn main() {
    let app = Router::new()
        .route("/users", get(db::users::list_users))
        .route("/posts", post(db::posts::create_post))
        .route("/cakes", get(db::cakes::list_cakes))
        .route("/stats", get(db::users::stats));
    let _ = app;
}
