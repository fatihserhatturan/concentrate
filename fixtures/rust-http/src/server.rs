use axum::{routing::{delete, get, post}, Router};

pub fn router() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/products", get(list_products).post(create_product))
        .route("/api/products/:id", get(get_product).delete(remove_product))
        .route("/api/orders", get(list_orders))
}

async fn health() {}
async fn list_products() {}
async fn create_product() {}
async fn get_product() {}
async fn remove_product() {}
async fn list_orders() {}
