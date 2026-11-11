use actix_web::{get, post, route, web, HttpResponse, Responder};

#[get("/users")]
pub async fn list(query: web::Query<Filter>) -> impl Responder {
    HttpResponse::Ok().body(query.q.clone())
}

#[post("/users")]
pub async fn create(body: web::Json<NewUser>, data: web::Data<Pool>) -> impl Responder {
    let _ = data;
    HttpResponse::Created().json(body.name.clone())
}

#[route("/users/{id}", method = "GET", method = "HEAD")]
pub async fn show(path: web::Path<u32>) -> impl Responder {
    HttpResponse::Ok().body(path.to_string())
}

pub struct Filter {
    pub q: String,
}

pub struct NewUser {
    pub name: String,
}

pub struct Pool;
