package service

import (
	"context"

	v1 "example.com/kr/api/v1"
)

type GreeterService struct {
	v1.UnimplementedGreeterServer
}

func greeting(name string) string {
	return "hello " + name
}

func (s *GreeterService) SayHello(ctx context.Context, in *v1.HelloReq) (*v1.HelloReply, error) {
	return &v1.HelloReply{Message: greeting(in.Name)}, nil
}

func (s *GreeterService) DeleteHello(ctx context.Context, in *v1.HelloReq) (*v1.HelloReply, error) {
	return &v1.HelloReply{}, nil
}
