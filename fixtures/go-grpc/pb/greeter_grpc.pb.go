// Code shaped like protoc-gen-go-grpc output.
package pb

import (
	"context"

	"google.golang.org/grpc"
)

type HelloRequest struct{ Name string }

type HelloReply struct{ Message string }

type GreeterServer interface {
	SayHello(context.Context, *HelloRequest) (*HelloReply, error)
	SayBye(context.Context, *HelloRequest) (*HelloReply, error)
	mustEmbedUnimplementedGreeterServer()
}

type UnimplementedGreeterServer struct{}

func (UnimplementedGreeterServer) SayHello(context.Context, *HelloRequest) (*HelloReply, error) {
	return nil, nil
}

func (UnimplementedGreeterServer) SayBye(context.Context, *HelloRequest) (*HelloReply, error) {
	return nil, nil
}

func (UnimplementedGreeterServer) mustEmbedUnimplementedGreeterServer() {}

func RegisterGreeterServer(s grpc.ServiceRegistrar, srv GreeterServer) {
	s.RegisterService(nil, srv)
}
