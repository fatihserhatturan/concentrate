package repo

import (
	"context"
	"database/sql"
)

type ProductRepo struct {
	Conn *sql.DB
}

// A helper running the SQL its callers pass: each caller makes the access.
func (r *ProductRepo) fetch(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	return r.Conn.QueryContext(ctx, query, args...)
}

func (r *ProductRepo) ByID(ctx context.Context, id int) (*sql.Rows, error) {
	query := `SELECT id, name FROM products WHERE id = ?`
	return r.fetch(ctx, query, id)
}

// SQL in a local; MySQL's INTO is optional.
func (r *ProductRepo) Store(ctx context.Context, name string) error {
	query := `INSERT  products SET name=?`
	stmt, err := r.Conn.PrepareContext(ctx, query)
	if err != nil {
		return err
	}
	_, err = stmt.ExecContext(ctx, name)
	return err
}
