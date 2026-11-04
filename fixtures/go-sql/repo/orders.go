package repo

import "github.com/jmoiron/sqlx"

type Order struct {
	ID    int    `db:"id"`
	Total int    `db:"total"`
}

type OrderRepo struct {
	DB *sqlx.DB
}

func Connect(dsn string) (*OrderRepo, error) {
	db, err := sqlx.Connect("postgres", dsn)
	if err != nil {
		return nil, err
	}
	return &OrderRepo{DB: db}, nil
}

func (r *OrderRepo) ForUser(userID int) ([]Order, error) {
	var orders []Order
	err := r.DB.Select(&orders, `
		SELECT o.id, o.total
		FROM orders o
		JOIN users u ON u.id = o.user_id
		WHERE u.id = $1`, userID)
	return orders, err
}

func (r *OrderRepo) Add(o Order) error {
	_, err := r.DB.NamedExec("INSERT INTO orders (id, total) VALUES (:id, :total)", o)
	return err
}

func (r *OrderRepo) Total(query string) (int, error) {
	var total int
	// Dynamic SQL: not read.
	err := r.DB.Get(&total, query)
	return total, err
}
