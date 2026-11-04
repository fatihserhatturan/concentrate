package api

import (
	"example.com/gormapp/store"
	"github.com/gin-gonic/gin"
)

func Register(r *gin.Engine, s *store.Store) {
	r.GET("/posts/count", func(c *gin.Context) {
		c.JSON(200, s.CountPosts())
	})
	r.DELETE("/categories/:slug", deleteCategory)
}

func deleteCategory(c *gin.Context) {
	store.DeleteCategory(c.Param("slug"))
}
