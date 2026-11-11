from typing import List, Optional

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import Column, ForeignKey, Integer, String, Table
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

db = SQLAlchemy()


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at = Column(String(32))


class Author(Base, TimestampMixin):
    __tablename__ = "authors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    bio: Mapped[Optional[str]]
    books: Mapped[List["Book"]] = relationship(back_populates="author")


class Book(Base):
    __tablename__ = "books"

    id = Column(Integer, primary_key=True)
    title = Column("book_title", String(120), nullable=False)
    author_id = Column(Integer, ForeignKey("authors.id"))
    author = relationship("Author", back_populates="books")
    reviews = relationship("Review", backref="book")


class Review(Base):
    __tablename__ = "reviews"

    id = Column(Integer, primary_key=True)
    book_id = Column(Integer, ForeignKey("books.id"), nullable=False)
    body = Column(String)


book_tags = Table("book_tags", Base.metadata, Column("book_id", Integer, ForeignKey("books.id")), Column("tag", String))


class Publisher(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    label = db.Column(db.String(50))
    books = db.relationship("Book", secondary=book_tags, backref="publishers")
