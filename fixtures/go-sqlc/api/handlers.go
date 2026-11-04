package api

import (
	"encoding/json"
	"net/http"

	"example.com/sqlcapp/db"
)

type Server struct {
	queries *db.Queries
}

func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /authors", s.createAuthor)
	mux.HandleFunc("GET /authors/{id}/books", s.listBooks)
}

func (s *Server) createAuthor(w http.ResponseWriter, r *http.Request) {
	author, err := s.queries.CreateAuthor(r.Context(), db.CreateAuthorParams{Name: r.FormValue("name")})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(author)
}

func (s *Server) listBooks(w http.ResponseWriter, r *http.Request) {
	books, _ := s.queries.ListAuthorBooks(r.Context(), 1)
	json.NewEncoder(w).Encode(books)
}

func NewServer(conn db.DBTX) *Server {
	return &Server{queries: db.New(conn)}
}
