package routes

import (
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRegister(t *testing.T) {
	r := gin.New()
	Register(r.Group("/test"))
}
