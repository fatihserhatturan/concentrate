package app

import (
	"github.com/google/wire"

	"example.com/wireapp/repo"
)

type Handler struct {
	Orders *repo.Orders
	Clock  repo.Clock
	name   string
}

type App struct {
	handler *Handler
}

func NewApp(h *Handler) *App { return &App{handler: h} }

var Set = wire.NewSet(
	repo.NewOrders,
	wire.Struct(new(Handler), "Orders", "Clock"),
	wire.Bind(new(repo.Clock), new(*repo.SystemClock)),
	wire.Value(repo.SystemClock{}),
	NewApp,
)
