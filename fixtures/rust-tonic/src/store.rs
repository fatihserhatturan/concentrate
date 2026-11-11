use tonic::{Request, Response, Status};

pub struct InventoryServer<T> {
    inner: T,
}

impl<T> InventoryServer<T> {
    pub fn from_arc(inner: std::sync::Arc<T>) -> Self {
        InventoryServer { inner: todo!() }
    }
}

pub struct StoreService;

impl StoreService {
    pub fn new() -> Self {
        StoreService
    }
}

#[tonic::async_trait]
impl Inventory for StoreService {
    async fn list_items(&self, request: Request<()>) -> Result<Response<()>, Status> {
        Ok(Response::new(()))
    }
}

pub trait Inventory {}
