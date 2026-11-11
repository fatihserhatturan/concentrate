use axum::{extract::Request, middleware::Next, response::Response};

pub async fn log_requests(request: Request, next: Next) -> Response {
    next.run(request).await
}

pub async fn require_admin(request: Request, next: Next) -> Response {
    next.run(request).await
}
