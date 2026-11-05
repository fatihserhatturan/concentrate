package main

import "example.com/ifaces/repo"

type Service struct {
	users repo.Users
	posts repo.Posts
}

func (s *Service) Load(ids map[int]bool) {
	for id := range ids {
		s.users.Get(id)
	}
	go func() {
		s.posts.Get(1)
	}()
	// `s` declared again in a nested block does not hide the receiver.
	if s, ok := ids[0]; ok {
		_ = s
	}
}

// A closure's parameter is typed in its body.
func save() error {
	return repo.Run(func(tx *repo.Tx) error {
		return tx.Save(repo.User{})
	})
}

func main() {
	svc := &Service{}
	svc.Load(nil)
	_ = save()
}
