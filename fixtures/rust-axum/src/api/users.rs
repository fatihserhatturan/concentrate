use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};

use crate::AppState;

pub fn routes() -> Router {
    Router::new()
        .route("/", get(list_users).post(create_user))
        .route("/:id", get(show_user).delete(delete_user))
}

async fn list_users(State(state): State<AppState>, Query(params): Query<ListParams>) -> Json<Vec<String>> {
    Json(vec![state.name, params.q])
}

async fn create_user(Json(body): Json<NewUser>) -> Json<NewUser> {
    Json(body)
}

async fn show_user(Path(id): Path<u64>) -> String {
    id.to_string()
}

async fn delete_user(Path(id): Path<u64>) -> String {
    id.to_string()
}

pub struct ListParams {
    pub q: String,
}

pub struct NewUser {
    pub name: String,
}

fn unused_router() -> Router {
    Router::new().route("/dead", post(create_user))
}
