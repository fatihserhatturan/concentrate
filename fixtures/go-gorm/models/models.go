package models

import "gorm.io/gorm"

type Author struct {
	gorm.Model
	Name  string
	Posts []Post `gorm:"foreignKey:WriterID"`
}

type Post struct {
	gorm.Model
	Title    string `gorm:"size:200"`
	WriterID uint
	Writer   Author
	Tags     []Tag `gorm:"many2many:post_tags;constraint:OnDelete:CASCADE"`
}

type Tag struct {
	ID   uint
	Name string `gorm:"uniqueIndex"`
}

type Category struct {
	ID   uint
	Slug string
}

func (Category) TableName() string {
	return "post_categories"
}
