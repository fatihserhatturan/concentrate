package service

import (
	"context"

	"example.com/grpcapp/pb"
)

type Greeter struct {
	pb.UnimplementedGreeterServer
}

func New() *Greeter {
	return &Greeter{}
}

func (g *Greeter) SayHello(ctx context.Context, req *pb.HelloRequest) (*pb.HelloReply, error) {
	return &pb.HelloReply{Message: "hello " + req.Name}, nil
}

// Close is exported but not part of the service.
func (g *Greeter) Close() {}
