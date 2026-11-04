package repo

import (
	"context"
	"database/sql"
)

const selectUser = `SELECT id, email FROM users WHERE id = $1`

type UserRepo struct {
	db *sql.DB
}

func NewUserRepo(db *sql.DB) *UserRepo {
	return &UserRepo{db: db}
}

func (r *UserRepo) Find(ctx context.Context, id int) (string, error) {
	var email string
	err := r.db.QueryRowContext(ctx, selectUser, id).Scan(new(int), &email)
	return email, err
}

func (r *UserRepo) Rename(ctx context.Context, id int, name string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE users SET name = $1 WHERE id = $2", name, id); err != nil {
		tx.Rollback()
		return err
	}
	if _, err := tx.Exec("INSERT INTO audit (user_id, action) VALUES ($1, 'rename') ON CONFLICT DO NOTHING", id); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (r *UserRepo) Purge(ctx context.Context) error {
	rows, err := r.db.Query("DELETE FROM sessions s USING users u WHERE s.user_id = u.id AND u.disabled RETURNING s.id")
	if err != nil {
		return err
	}
	return rows.Close()
}
