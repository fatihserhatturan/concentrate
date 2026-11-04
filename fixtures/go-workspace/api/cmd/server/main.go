package main

import (
	"log"

	"example.com/api/internal/handler"
	db "example.com/store"
	_ "github.com/lib/pq"
)

func main() {
	repo, err := db.NewRepo("postgres://local")
	if err != nil {
		log.Fatal(err)
	}
	h := handler.New(repo)
	h.Serve()
	setup()
}
