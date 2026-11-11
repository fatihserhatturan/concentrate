mod greeter;
mod store;

use std::sync::Arc;

use tonic::transport::Server;

use crate::greeter::{GreeterServer, MyGreeter};
use crate::store::{InventoryServer, StoreService};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "[::1]:50051".parse()?;
    let greeter = MyGreeter::default();
    let store = Arc::new(StoreService::new());
    Server::builder()
        .add_service(GreeterServer::new(greeter))
        .add_service(InventoryServer::from_arc(store))
        .serve(addr)
        .await?;
    Ok(())
}
