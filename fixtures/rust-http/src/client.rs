use reqwest::{Client, Method};

const BASE: &str = "http://localhost:8080";
static SHARED: once_cell::sync::Lazy<Client> = once_cell::sync::Lazy::new(Client::new);

pub struct Api {
    http: reqwest::Client,
    base: String,
}

impl Api {
    pub async fn product(&self, id: u32) {
        let _ = self.http.get(format!("{}/api/products/{}", self.base, id)).send().await;
    }

    pub async fn create(&self) {
        let url = format!("{BASE}/api/products");
        let _ = self.http.post(&url).send().await;
    }
}

pub async fn health() {
    let _ = reqwest::get("http://localhost:8080/health").await;
}

pub async fn products(client: &Client) {
    let _ = client.get(format!("{BASE}/api/products?limit=10")).send().await;
}

pub async fn remove(id: u32) {
    let client = Client::builder().build().unwrap();
    let _ = client.delete(format!("{BASE}/api/products/{id}")).send().await;
    let _ = client.request(Method::DELETE, "/api/products/1").send().await;
}

pub async fn orders() {
    let url = std::env::var("ORDERS_URL").unwrap();
    let _ = SHARED.get(url).send().await;
}

pub fn chained() {
    let _ = reqwest::blocking::Client::new().get("http://localhost:8080/api/orders").send();
}

pub fn not_a_client(cache: &std::collections::HashMap<String, String>) {
    let _ = cache.get("/health");
}
