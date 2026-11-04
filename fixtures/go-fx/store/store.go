package store

import "database/sql"

type Config struct {
	DSN string
}

// UserStore is what the services depend on.
type UserStore interface {
	Find(id int) (string, error)
}

type sqlUserStore struct {
	db *sql.DB
}

func (s *sqlUserStore) Find(id int) (string, error) { return "", nil }

// NewUserStore returns the interface; fx.As binds it below.
func NewUserStore(cfg *Config, db *sql.DB) UserStore {
	return &sqlUserStore{db: db}
}

type AuditLog struct{}

func NewAuditLog() *AuditLog { return &AuditLog{} }
