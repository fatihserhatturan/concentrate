mod cli;
mod settings; mod keys;

use axum::{routing::get, Router};
use std::env;

const REGION_KEY: &str = "REGION";
static BUILD_TAG: &str = env!("BUILD_TAG");

fn main() {
    dotenvy::dotenv().ok();
    let port = env::var("PORT").unwrap_or_default();
    let debug = std::env::var_os("DEBUG");
    let sha = option_env!("GIT_SHA");
    let _ = (port, debug, sha);
    let app = Router::new().route("/region", get(region));
    let _ = app;
}

async fn region() -> String {
    env::var(REGION_KEY).unwrap_or_default()
}

// The key is a constant of another file.
fn shared() -> String {
    env::var(keys::env_key::SHARED_KEY).unwrap_or_default()
}
