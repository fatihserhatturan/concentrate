package main

import (
	"github.com/labstack/echo/v4"

	"example.com/split/api"
	"example.com/split/router"
	"example.com/split/store"
)

// router.New returns the *echo.Echo. main also declares a route of its own on
// an echo it creates, so the file has routes before router.New is known.
func main() {
	admin := echo.New()
	admin.GET("/admin/status", health)

	r := router.New()
	r.GET("/health", health)
	v1 := r.Group("/api")
	h := api.NewHandler(store.New())
	h.Register(v1)
	// The same handler mounted again through a chained call.
	api.NewHandler(store.New()).Register(r.Group("/v2"))
	r.Logger.Fatal(r.Start(":1323"))
}

func health(c interface{ String(int, string) error }) error { return c.String(200, "ok") }
