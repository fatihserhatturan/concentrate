#include "client.h"
using helloworld::Greeter;
GreeterClient::GreeterClient(std::shared_ptr<grpc::Channel> channel) : stub_(Greeter::NewStub(channel)) {}

std::string GreeterClient::SayHello(const std::string &user) {
  helloworld::HelloRequest request;
  helloworld::HelloReply reply;
  grpc::ClientContext context;
  grpc::Status status = stub_->SayHello(&context, request, &reply);
  return status.ok() ? reply.message() : "RPC failed";
}

int main() {
  auto stub = Greeter::NewStub(grpc::CreateChannel("localhost:50051", grpc::InsecureChannelCredentials()));
  grpc::ClientContext ctx;
  helloworld::HelloRequest req;
  auto reader = stub->SayHelloStreamReply(&ctx, req);
  GreeterClient client(grpc::CreateChannel("localhost:50051", grpc::InsecureChannelCredentials()));
  client.SayHello("world");
}
