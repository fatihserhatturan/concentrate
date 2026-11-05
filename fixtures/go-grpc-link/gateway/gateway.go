package gateway

import (
	"context"

	"github.com/google/wire"

	v1 "example.com/grpclink/api/user/v1"
)

type Conf struct {
	Endpoint string
}

type Gateway struct {
	uc v1.UserClient
}

// The client the gRPC package generates is not built from Conf.
func NewUserClient(c *Conf) v1.UserClient {
	return v1.NewUserClient(nil)
}

func NewGateway(uc v1.UserClient) *Gateway {
	return &Gateway{uc: uc}
}

func (g *Gateway) Register(ctx context.Context, name string) (int64, error) {
	reply, err := g.uc.Save(ctx, &v1.SaveReq{Name: name})
	if err != nil {
		return 0, err
	}
	return reply.ID, nil
}

var ProviderSet = wire.NewSet(NewUserClient, NewGateway)
