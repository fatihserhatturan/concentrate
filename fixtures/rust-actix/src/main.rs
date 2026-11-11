mod users;

use actix_web::{get, middleware::Logger, web, App, HttpResponse, HttpServer, Responder};

#[get("/health")]
async fn health() -> impl Responder {
    HttpResponse::Ok().body("ok")
}

async fn version() -> impl Responder {
    "1.0"
}

async fn echo(body: web::Json<String>) -> impl Responder {
    body.into_inner()
}

fn configure_misc(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/echo").route(web::post().to(echo)));
    cfg.route("/version", web::get().to(version));
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .wrap(Logger::default())
            .service(health)
            .service(
                web::scope("/api")
                    .service(users::list)
                    .service(users::create)
                    .service(web::scope("/v2").service(users::show)),
            )
            .configure(configure_misc)
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}
