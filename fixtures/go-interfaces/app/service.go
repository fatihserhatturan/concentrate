package app

import "example.com/shop/storage"

type Service struct {
	cache storage.Cache
}

func (s *Service) Load(id string) string {
	value, _ := s.cache.Get(id)
	return value
}

func Save(store storage.Store, id string) {
	store.Put(id, "x")
	store.Close()
}
