package main

import (
	"net/http"

	"github.com/gorilla/mux"
)

func list(w http.ResponseWriter, r *http.Request) {}

func show(w http.ResponseWriter, r *http.Request) {}

func logging(next http.Handler) http.Handler {
	return next
}

func auth(next http.Handler) http.Handler {
	return next
}

func main() {
	r := mux.NewRouter()
	r.HandleFunc("/", list)
	r.HandleFunc("/items", list).Methods("GET")
	r.HandleFunc("/items/{id}", show).Methods("PUT", "PATCH").Name("item")

	api := r.PathPrefix("/api").Subrouter()
	api.Use(auth)
	api.HandleFunc("/users", list).Methods(http.MethodGet)

	r.PathPrefix("/static/").Handler(http.StripPrefix("/static/", http.FileServer(http.Dir("."))))
	// gorilla/mux middleware runs for every route of the router.
	r.Use(logging)

	http.ListenAndServe(":8080", r)
}
