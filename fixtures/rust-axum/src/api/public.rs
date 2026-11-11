use axum::{routing::get, Router};

pub fn routes() -> Router {
    let mut router = Router::new().route("/about", get(about));
    for page in ["terms", "privacy"] {
        router = router.route(&format!("/{page}"), get(about));
    }
    router
}

async fn about() -> &'static str {
    "about"
}
