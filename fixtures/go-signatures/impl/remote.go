package impl

import "example.com/ifaces/repo"

// Remote returns repo.User, so it implements repo.Users (written there as
// User) and not other.Users.
type Remote struct{}

func (Remote) Get(id int) (repo.User, error) { return repo.User{}, nil }
