use actix_web::web;
use actix_web::web::{get, post};
use actix_web::{HttpResponse, Responder};

async fn index() -> impl Responder {
    HttpResponse::Ok()
}

async fn make() -> impl Responder {
    HttpResponse::Created()
}

// The verbs are imported bare: `get().to(h)`.
pub fn api(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/bare")
            .route("", get().to(index))
            .route("/new", post().to(make)),
    );
}
