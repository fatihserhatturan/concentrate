package api

import (
	"context"

	"go.uber.org/fx"

	"example.com/fxapp/service"
)

type Server struct {
	users  *service.Users
	mailer *service.Mailer
}

func NewServer(users *service.Users, mailer *service.Mailer) *Server {
	return &Server{users: users, mailer: mailer}
}

func Register(lc fx.Lifecycle, s *Server) {
	lc.Append(fx.Hook{OnStart: func(context.Context) error { return nil }})
}
