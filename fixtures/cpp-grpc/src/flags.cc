#include <grpcpp/grpcpp.h>
#include "greeter.grpc.pb.h"

using grpc::ServerContext;
using grpc::Status;
using helloworld::Greeter;

#define MAKE_FLAG(name) \
  ABSL_FLAG(bool, name, false, "doc")

ABSL_FLAG(uint16_t, port, 50051, "Server port for the service");

// The flag above reads as a declaration without a type and used to take this class with it.
class FlagService final : public Greeter::Service {
  Status SayHello(ServerContext *context, const helloworld::HelloRequest *request, helloworld::HelloReply *reply) override {
    return Status::OK;
  }
};
