use tonic::{Request, Response, Status};

pub struct HelloRequest {
    pub name: String,
}

pub struct HelloReply {
    pub message: String,
}

pub trait Greeter {
    fn say_hello(&self);
}

pub struct GreeterServer<T> {
    inner: T,
}

impl<T> GreeterServer<T> {
    pub fn new(inner: T) -> Self {
        GreeterServer { inner }
    }
}

#[derive(Default)]
pub struct MyGreeter;

#[tonic::async_trait]
impl Greeter for MyGreeter {
    async fn say_hello(&self, request: Request<HelloRequest>) -> Result<Response<HelloReply>, Status> {
        Ok(Response::new(HelloReply { message: format!("Hello {}", request.into_inner().name) }))
    }

    async fn say_goodbye(&self, request: Request<HelloRequest>) -> Result<Response<HelloReply>, Status> {
        Ok(Response::new(HelloReply { message: request.into_inner().name }))
    }
}

impl MyGreeter {
    pub fn helper(&self) {}
}
