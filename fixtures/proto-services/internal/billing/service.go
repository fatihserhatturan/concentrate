package billing

import (
	"context"

	grpc "google.golang.org/grpc"

	v1 "example.com/protosvc/gen/billing/v1"
)

type Service struct {
	v1.UnimplementedBillingServer
}

func (s *Service) Charge(ctx context.Context, in *v1.ChargeReq) (*v1.ChargeReply, error) {
	return &v1.ChargeReply{OK: true}, nil
}

func (s *Service) Refund(stream grpc.ServerStream) error { return nil }

func (s *Service) Audit(ctx context.Context, in *v1.ChargeReq) (*v1.ChargeReply, error) {
	return &v1.ChargeReply{}, nil
}
