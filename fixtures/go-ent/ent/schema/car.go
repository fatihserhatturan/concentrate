package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
)

type Car struct {
	ent.Schema
}

func (Car) Fields() []ent.Field {
	return []ent.Field{field.String("model")}
}

func (Car) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("owner", User.Type).Ref("cars").Unique(),
	}
}
