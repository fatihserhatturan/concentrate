package repo

type User struct{ Name string }

type Post struct{ Title string }

// Two interfaces with a method of the same name and other results.
type Users interface {
	Get(id int) (User, error)
}

type Posts interface {
	Get(id int) (Post, error)
}

type UserRepo struct{}

func (UserRepo) Get(id int) (User, error) { return User{}, nil }

type PostRepo struct{}

func (r *PostRepo) Get(id int) (res Post, err error) { return Post{}, nil }

// A Get with other parameters implements neither.
type Handler struct{}

func (Handler) Get(name string) error { return nil }

type Tx struct{}

func (Tx) Save(u User) error { return nil }

func Run(fn func(tx *Tx) error) error { return fn(&Tx{}) }
