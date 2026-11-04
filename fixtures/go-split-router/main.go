package main

import (
	"example.com/split/api"
	"example.com/split/router"
	"example.com/split/store"
)

// main does not import echo: router.New returns the *echo.Echo.
func main() {
	r := router.New()
	r.GET("/health", health)
	v1 := r.Group("/api")
	h := api.NewHandler(store.New())
	h.Register(v1)
	r.Logger.Fatal(r.Start(":1323"))
}

func health(c interface{ String(int, string) error }) error { return c.String(200, "ok") }
