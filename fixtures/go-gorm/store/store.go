package store

import (
	"example.com/gormapp/models"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

var DB *gorm.DB

type Store struct {
	db *gorm.DB
}

func Open() (*gorm.DB, error) {
	db, err := gorm.Open(sqlite.Open("app.db"), &gorm.Config{})
	if err != nil {
		return nil, err
	}
	db.AutoMigrate(&models.Author{}, &models.Post{}, &models.Tag{}, &models.Category{})
	DB = db
	return db, nil
}

func (s *Store) Posts(authorID uint) ([]models.Post, error) {
	var posts []models.Post
	err := s.db.Preload("Writer").Preload("Tags").Where("writer_id = ?", authorID).Find(&posts).Error
	return posts, err
}

func (s *Store) CountPosts() int64 {
	var n int64
	s.db.Model(&models.Post{}).Count(&n)
	return n
}

func (s *Store) Publish(post *models.Post) error {
	tx := s.db.Begin()
	if err := tx.Create(post).Error; err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit().Error
}

func (s *Store) Retag(post *models.Post, tags []models.Tag) error {
	return s.db.Model(post).Association("Tags").Replace(tags)
}

func RenameAuthor(id uint, name string) {
	DB.Model(&models.Author{}).Where("id = ?", id).Update("name", name)
}

func DeleteCategory(slug string) {
	DB.Where(models.Category{Slug: slug}).Delete(&models.Category{})
}

func Archive() {
	DB.Exec("INSERT INTO archived_posts SELECT * FROM posts WHERE deleted_at IS NOT NULL")
	DB.Table("audit_log").Create(map[string]interface{}{"event": "archive"})
}

func Popular() []models.Tag {
	var tags []models.Tag
	DB.Raw("SELECT tags.* FROM tags JOIN post_tags ON post_tags.tag_id = tags.id").Scan(&tags)
	return tags
}
