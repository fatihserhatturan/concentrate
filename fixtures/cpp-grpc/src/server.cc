#include <grpcpp/grpcpp.h>
#include "greeter.grpc.pb.h"

using grpc::ServerContext;
using grpc::Status;
using helloworld::Greeter;
using helloworld::HelloReply;
using helloworld::HelloRequest;

class GreeterServiceImpl final : public Greeter::Service {
  Status SayHello(ServerContext *context, const HelloRequest *request, HelloReply *reply) override {
    reply->set_message("Hello " + request->name());
    return Status::OK;
  }
  Status SayHelloStreamReply(ServerContext *context, const HelloRequest *request, grpc::ServerWriter<HelloReply> *writer) override {
    return Status::OK;
  }
};

class CallbackImpl : public helloworld::Greeter::CallbackService {
  grpc::ServerUnaryReactor *SayHello(grpc::CallbackServerContext *context, const HelloRequest *request, HelloReply *reply) override {
    auto *reactor = context->DefaultReactor();
    reactor->Finish(Status::OK);
    return reactor;
  }
};

void RunServer() {
  GreeterServiceImpl service;
  grpc::ServerBuilder builder;
  builder.RegisterService(&service);
}
