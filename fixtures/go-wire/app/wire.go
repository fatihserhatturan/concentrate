//go:build wireinject

package app

import "github.com/google/wire"

func InitializeApp() *App {
	wire.Build(Set)
	return nil
}
