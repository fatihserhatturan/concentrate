package store

type Item struct {
	Name string
}

func (i Item) Label() string { return i.Name }

type Store struct {
	items []Item
}

func New() *Store { return &Store{} }

func (s *Store) All() []Item { return s.items }

func (s *Store) ByName() map[string]Item { return nil }

func (s *Store) Get(name string) *Item { return &Item{Name: name} }
