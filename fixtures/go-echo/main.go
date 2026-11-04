package main

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

func list(c echo.Context) error {
	return c.JSON(http.StatusOK, nil)
}

func show(c echo.Context) error {
	return nil
}

func auth(next echo.HandlerFunc) echo.HandlerFunc {
	return next
}

func audit(next echo.HandlerFunc) echo.HandlerFunc {
	return next
}

func main() {
	e := echo.New()
	e.GET("/health", list)
	// The root's middleware runs for every route, those registered before too.
	e.Use(middleware.Logger())
	e.Use(auth)

	api := e.Group("/api", audit)
	api.GET("/users", list)
	api.POST("/users", show, audit)
	api.Match([]string{"PUT", "PATCH"}, "/users/:id", show)
	admin(api.Group("/admin"))

	e.Add(http.MethodDelete, "/cache", show)
	e.Start(":8080")
}

func admin(g *echo.Group) {
	g.Use(auth)
	g.GET("/stats", list)
}
