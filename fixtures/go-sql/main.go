package main

import (
	"context"
	"database/sql"
	"log"

	_ "github.com/lib/pq"

	"example.com/sqlapp/repo"
)

func main() {
	db, err := sql.Open("postgres", "postgres://localhost/app")
	if err != nil {
		log.Fatal(err)
	}
	users := repo.NewUserRepo(db)
	if _, err := users.Find(context.Background(), 1); err != nil {
		log.Fatal(err)
	}
	var count int
	db.QueryRow("SELECT count(*) FROM orders").Scan(&count)
}
