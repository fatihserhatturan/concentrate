package user

import (
	"context"

	grpc "google.golang.org/grpc"

	v1 "example.com/grpclink/api/user/v1"
)

type UserService struct {
	v1.UnimplementedUserServer
}

func store(name string) int64 { return int64(len(name)) }

func (s *UserService) Save(ctx context.Context, in *v1.SaveReq) (*v1.SaveReply, error) {
	return &v1.SaveReply{ID: store(in.Name)}, nil
}

func (s *UserService) Get(ctx context.Context, in *v1.SaveReq) (*v1.SaveReply, error) {
	return &v1.SaveReply{}, nil
}

func (s *UserService) Watch(in *v1.SaveReq, stream grpc.ServerStream) error {
	return nil
}
