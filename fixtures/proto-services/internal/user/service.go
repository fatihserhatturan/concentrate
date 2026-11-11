package user

import (
	"context"

	grpc "google.golang.org/grpc"

	v1 "example.com/protosvc/gen/user/v1"
)

type Service struct {
	v1.UnimplementedUserServer
}

func (s *Service) Save(ctx context.Context, in *v1.SaveReq) (*v1.SaveReply, error) {
	return &v1.SaveReply{}, nil
}

func (s *Service) Get(ctx context.Context, in *v1.SaveReq) (*v1.SaveReply, error) {
	return &v1.SaveReply{}, nil
}

func (s *Service) Watch(in *v1.SaveReq, stream grpc.ServerStream) error { return nil }

func (s *Service) Ping(ctx context.Context, in *v1.SaveReq) (*v1.SaveReply, error) {
	return &v1.SaveReply{}, nil
}
