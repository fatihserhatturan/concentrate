package main

import (
	"database/sql"
	"net/http"

	"example.com/sqlcapp/api"
)

func main() {
	conn, _ := sql.Open("postgres", "postgres://localhost/app")
	mux := http.NewServeMux()
	server := api.NewServer(conn)
	server.Routes(mux)
	http.ListenAndServe(":8080", mux)
}
