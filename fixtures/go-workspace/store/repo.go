package store

type Repo struct {
	dsn string
}

func NewRepo(dsn string) (*Repo, error) {
	return &Repo{dsn: dsn}, nil
}
