package main

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"example.com/ginapp/auth"
	"example.com/ginapp/routes"
)

const healthPath = "/health"

type Handler struct{}

func (h *Handler) List(c *gin.Context) {
	c.JSON(http.StatusOK, nil)
}

func ping(c *gin.Context) {
	c.String(http.StatusOK, "pong")
}

func main() {
	r := gin.Default()
	r.Use(gin.Recovery(), auth.Logger)

	r.GET(healthPath, ping)
	r.Handle("OPTIONS", "/ping", ping)
	r.Any("/echo", ping)

	h := &Handler{}
	v1 := r.Group("/api/v1")
	v1.GET("/items", h.List)
	routes.Register(v1.Group("/users"))

	v1.Use(auth.Required(true))
	v1.POST("/items", func(c *gin.Context) {
		ping(c)
	})

	r.Run(":8080")
}

func dynamic(r *gin.Engine, path string) {
	r.GET(path, ping)
}
