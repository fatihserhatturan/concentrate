package other

// The same names as package repo's, other types: Local implements this
// Users and not repo's, whose Get returns repo.User.
type User struct{ ID int }

type Users interface {
	Get(id int) (User, error)
}

type Local struct{}

func (Local) Get(id int) (User, error) { return User{}, nil }
