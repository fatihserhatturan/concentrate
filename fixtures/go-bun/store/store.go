package store

import (
	"context"
	"database/sql"

	"github.com/uptrace/bun"
)

// A table named by the embedded BaseModel's tag.
type User struct {
	bun.BaseModel `bun:"table:people,alias:p"`

	ID    int64   `bun:"id,pk,autoincrement"`
	Posts []*Post `bun:"rel:has-many,join:id=author_id"`
}

// bun's own table name: `posts`.
type Post struct {
	ID       int64 `bun:"id,pk,autoincrement"`
	AuthorID int64
}

type Store struct {
	db *bun.DB
}

func New(db *bun.DB) *Store { return &Store{db: db} }

func (s *Store) User(ctx context.Context, id int64) (*User, error) {
	user := &User{ID: id}
	err := s.db.NewSelect().Model(user).WherePK().Relation("Posts").Scan(ctx)
	return user, err
}

func (s *Store) CountPosts(ctx context.Context) (int, error) {
	return s.db.NewSelect().Model((*Post)(nil)).Count(ctx)
}

func (s *Store) Save(ctx context.Context, user *User) error {
	_, err := s.db.NewInsert().Model(user).On("CONFLICT (id) DO UPDATE").Exec(ctx)
	return err
}

// A transaction, and a query by table name without a model.
func (s *Store) Purge(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		return err
	}
	if _, err := tx.NewDelete().Model((*Post)(nil)).Where("author_id = ?", id).Exec(ctx); err != nil {
		return tx.Rollback()
	}
	if _, err := tx.NewUpdate().Table("audit").Set("purged = true").Where("user_id = ?", id).Exec(ctx); err != nil {
		return tx.Rollback()
	}
	return tx.Commit()
}

// A query built but not run is not an access.
func (s *Store) Query() *bun.SelectQuery {
	return s.db.NewSelect().Model((*User)(nil))
}
