package admin

import (
	"context"

	v1 "example.com/protosvc/gen/user/v1"
)

// A second implementation of the same service.
type Service struct {
	v1.UnimplementedUserServer
}

func (s *Service) Save(ctx context.Context, in *v1.SaveReq) (*v1.SaveReply, error) {
	return &v1.SaveReply{}, nil
}

func (s *Service) Get(ctx context.Context, in *v1.SaveReq) (*v1.SaveReply, error) {
	return &v1.SaveReply{}, nil
}
