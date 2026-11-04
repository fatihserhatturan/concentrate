package server

import (
	"os"

	"example.com/envapp/config"
	"github.com/gin-gonic/gin"
)

func Run(cfg config.Config) {
	r := gin.Default()
	r.GET("/health", func(c *gin.Context) {
		c.String(200, os.Getenv("RELEASE"))
	})
	r.GET("/region", region)
	r.Run()
}

func region(c *gin.Context) {
	c.String(200, os.Getenv("REGION"))
}
