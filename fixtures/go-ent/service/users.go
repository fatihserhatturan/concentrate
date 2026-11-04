package service

import (
	"context"

	"example.com/entapp/ent"
	"example.com/entapp/ent/user"
)

type Users struct {
	client *ent.Client
}

func (s *Users) Adults(ctx context.Context) ([]*ent.User, error) {
	return s.client.User.Query().Where(user.AgeGTE(18)).WithCars().All(ctx)
}

func (s *Users) Register(ctx context.Context, name string) (*ent.User, error) {
	return s.client.User.Create().SetName(name).SetAge(30).Save(ctx)
}

func Garage(ctx context.Context, client *ent.Client, u *ent.User) ([]*ent.Car, error) {
	return client.User.QueryCars(u).All(ctx)
}

func Sell(ctx context.Context, tx *ent.Tx, id int) error {
	if err := tx.Car.DeleteOneID(id).Exec(ctx); err != nil {
		return err
	}
	return tx.User.Update().Where(user.AgeLT(0)).SetAge(0).Exec(ctx)
}

func Lookup(ctx context.Context, users *ent.UserClient, id int) (*ent.User, error) {
	return users.Get(ctx, id)
}
