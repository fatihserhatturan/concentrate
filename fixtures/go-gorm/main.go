package main

import (
	"example.com/gormapp/api"
	"example.com/gormapp/store"
	"github.com/gin-gonic/gin"
)

func main() {
	if _, err := store.Open(); err != nil {
		panic(err)
	}
	r := gin.Default()
	api.Register(r, &store.Store{})
	r.Run()
}
