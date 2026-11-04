package main

import (
	"go.uber.org/fx"

	"example.com/fxapp/api"
	"example.com/fxapp/service"
	"example.com/fxapp/store"
)

func main() {
	fx.New(
		fx.Supply(&store.Config{DSN: "postgres://"}),
		fx.Provide(
			fx.Annotate(store.NewUserStore, fx.As(new(store.UserStore))),
			store.NewAuditLog,
			api.NewServer,
		),
		service.Module,
		fx.Invoke(api.Register),
	).Run()
}
