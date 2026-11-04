package store

import "example.com/split/model"

type Items interface {
	Find(name string) (*model.Item, error)
	All() []model.Item
}

type memory struct{}

func New() Items { return &memory{} }

func (m *memory) Find(name string) (*model.Item, error) { return &model.Item{Name: name}, nil }
func (m *memory) All() []model.Item                       { return nil }
