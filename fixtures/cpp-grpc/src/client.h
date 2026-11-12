#pragma once
#include <memory>
#include <grpcpp/grpcpp.h>
#include "greeter.grpc.pb.h"
class GreeterClient {
 public:
  GreeterClient(std::shared_ptr<grpc::Channel> channel);
  std::string SayHello(const std::string &user);
 private:
  std::unique_ptr<helloworld::Greeter::Stub> stub_;
};
