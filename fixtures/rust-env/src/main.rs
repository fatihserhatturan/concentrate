mod cli;
mod settings;

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
