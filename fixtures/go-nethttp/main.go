package main

import (
	"net/http"
)

type orders struct{}

func (o *orders) create(w http.ResponseWriter, r *http.Request) {}

type server struct {
	mux *http.ServeMux
}

func (s *server) metrics(w http.ResponseWriter, r *http.Request) {}

func (s *server) routes() {
	s.mux.HandleFunc("/metrics", s.metrics)
}

func getItem(w http.ResponseWriter, r *http.Request) {}

func health(w http.ResponseWriter, r *http.Request) {}

func secure(w http.ResponseWriter, r *http.Request) {}

func clearCache(w http.ResponseWriter, r *http.Request) {}

func withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

func registerAdmin(mux *http.ServeMux) {
	mux.HandleFunc("DELETE /admin/cache", clearCache)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", getItem)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("public"))))
	mux.Handle("/secure", withAuth(http.HandlerFunc(secure)))

	o := &orders{}
	api := http.NewServeMux()
	api.HandleFunc("POST /orders", o.create)
	mux.Handle("/api/", http.StripPrefix("/api", api))

	mux.Handle("/v2/", http.StripPrefix("/v2", v2Routes()))

	registerAdmin(mux)
	http.HandleFunc("/health", health)

	http.ListenAndServe(":8080", mux)
}

func v2Routes() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /ping", health)
	return m
}
