use rocket::serde::json::Json;
use rocket::{Route, State};

pub struct Store;

#[get("/")]
fn list(store: &State<Store>) -> Json<Vec<String>> {
    let _ = store;
    Json(Vec::new())
}

#[get("/<id>")]
fn show(id: u32) -> String {
    id.to_string()
}

#[post("/", data = "<post>")]
fn create(post: Json<String>) -> Json<String> {
    post
}

pub fn routes() -> Vec<Route> {
    routes![list, show, create]
}
