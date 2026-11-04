package store

func (r *Repo) Find(id int) string {
	return r.query(id)
}

func (r *Repo) query(id int) string {
	return r.dsn
}
