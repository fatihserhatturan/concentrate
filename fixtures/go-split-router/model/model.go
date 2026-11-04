package model

type Item struct {
	Name string
}

func (i *Item) Label() string { return i.Name }
