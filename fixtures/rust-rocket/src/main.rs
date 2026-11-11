#[macro_use]
extern crate rocket;

mod posts;

use rocket::serde::json::Json;

#[get("/")]
fn index() -> &'static str {
    "hello"
}

#[get("/health?<verbose>")]
fn health(verbose: Option<bool>) -> &'static str {
    let _ = verbose;
    "ok"
}

#[launch]
fn rocket() -> _ {
    rocket::build()
        .mount("/", routes![index, health])
        .mount("/posts", posts::routes())
}

#[allow(dead_code)]
fn unused() -> Json<u8> {
    Json(1)
}
