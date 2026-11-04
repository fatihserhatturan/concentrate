package auth

import "github.com/gin-gonic/gin"

func Required(strict bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
	}
}

func Logger(c *gin.Context) {
	c.Next()
}

func Audit(c *gin.Context) {
	c.Next()
}
