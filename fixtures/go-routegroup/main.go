package main

import (
	"net/http"

	"github.com/go-pkgz/routegroup"
)

func list(w http.ResponseWriter, r *http.Request) {}

func show(w http.ResponseWriter, r *http.Request) {}

func auth(next http.Handler) http.Handler {
	return next
}

func logging(next http.Handler) http.Handler {
	return next
}

func main() {
	router := routegroup.New(http.NewServeMux())
	router.Use(logging)
	router.HandleFunc("GET /health", list)

	api := router.Mount("/api/v1")
	api.HandleFunc("GET /items", list)
	api.With(auth).HandleFunc("POST /items", show)

	api.Mount("/admin").Route(func(admin *routegroup.Bundle) {
		admin.Use(auth)
		admin.HandleFunc("DELETE /cache", show)
		admin.HandleRootFunc("GET", list)
	})

	router.Route(func(base *routegroup.Bundle) {
		base.Use(auth)
		base.HandleFunc("PUT /private", show)
	})

	sub := routegroup.Mount(http.NewServeMux(), "/v2")
	sub.Handle("/files/", http.FileServer(http.Dir(".")))

	http.ListenAndServe(":8080", router)
}
