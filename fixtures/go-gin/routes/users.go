package routes

import (
	"github.com/gin-gonic/gin"

	"example.com/ginapp/auth"
)

func Show(c *gin.Context) {}

func Create(c *gin.Context) {}

func Register(router *gin.RouterGroup) {
	router.GET("", Show)
	router.GET("/:id", Show)
	router.Use(auth.Required(false))
	router.POST("/", auth.Audit, Create)
	registerAdmin(router.Group("/admin"))
}

func registerAdmin(admin gin.IRouter) {
	admin.DELETE("/:id", Create)
}
