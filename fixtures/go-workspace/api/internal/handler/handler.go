package handler

import (
	"fmt"

	"example.com/store"
)

type Base struct{}

func (Base) Log(message string) {
	fmt.Println(message)
}

type Handler struct {
	Base
	repo *store.Repo
}

func New(repo *store.Repo) *Handler {
	return &Handler{repo: repo}
}

func (h *Handler) Serve() {
	h.repo.Find(1)
	h.Log("served")
	h.audit()
	for _, store := range []int{1} {
		store.Close()
	}
}
