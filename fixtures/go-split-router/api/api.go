package api

import (
	"github.com/labstack/echo/v4"

	"example.com/split/model"
	"example.com/split/store"
)

type Handler struct {
	items store.Items
}

func (h *Handler) Register(g *echo.Group) {
	g.GET("/items", h.List)
	g.GET("/items/", h.List)
	g.GET("/items/:name", h.Get)
}

// A local from a method of an interface field: its result type.
func (h *Handler) Get(c echo.Context) error {
	item, err := h.items.Find(c.Param("name"))
	if err != nil {
		return err
	}
	return c.String(200, item.Label())
}

// A range variable over a typed slice.
func labels(items []model.Item) []string {
	out := []string{}
	for _, item := range items {
		out = append(out, item.Label())
	}
	return out
}

func (h *Handler) List(c echo.Context) error {
	return c.JSON(200, labels(h.items.All()))
}

// A method called on the result of an interface field's method.
func (h *Handler) defaultLabel() string { return h.items.Default().Label() }

func NewHandler(items store.Items) *Handler { return &Handler{items: items} }
