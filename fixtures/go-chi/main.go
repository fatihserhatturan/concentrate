package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func list(w http.ResponseWriter, r *http.Request) {}

func show(w http.ResponseWriter, r *http.Request) {}

func auth(next http.Handler) http.Handler {
	return next
}

func main() {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Get("/", list)

	r.Route("/articles", func(r chi.Router) {
		r.Get("/", list)
		r.With(auth).Post("/", show)
		r.Route("/{id}", func(r chi.Router) {
			r.Get("/", show)
		})
	})

	r.Group(func(r chi.Router) {
		r.Use(auth)
		r.Delete("/cache", show)
	})

	r.Mount("/admin", adminRouter())
	r.Route("/users", userRoutes)
	r.Method("PATCH", "/x", http.HandlerFunc(show))
	r.Mount("/debug", middleware.Profiler())

	http.ListenAndServe(":3000", r)
}

func adminRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(auth)
	r.Get("/stats", list)
	return r
}

func userRoutes(r chi.Router) {
	r.Get("/{name}", show)
}
