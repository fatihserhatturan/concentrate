import sqlite3

from sqlalchemy import delete, insert, select, text, update
from sqlalchemy.orm import Session

from .models import Author, Book, Publisher, Review


def list_authors(session: Session):
    return session.query(Author).filter(Author.name != "").all()


def find_book(session: Session, book_id: int):
    return session.get(Book, book_id)


def titles(session: Session):
    return session.scalars(select(Book.title).join(Author)).all()


def add_author(session: Session, name: str):
    author = Author(name=name)
    session.add(author)
    session.commit()
    return author


def rename_author(session: Session, author_id: int, name: str):
    session.execute(update(Author).where(Author.id == author_id).values(name=name))
    session.query(Review).filter(Review.id == 1).delete()


def remove_review(session: Session, review: Review):
    session.delete(review)


def bulk(session: Session):
    session.execute(insert(Publisher).values(label="x"))
    session.execute(delete(Book))


def legacy():
    return Publisher.query.filter_by(label="x").first()


def raw_sqlite(path):
    conn = sqlite3.connect(path)
    cursor = conn.cursor()
    cursor.execute("SELECT b.book_title FROM books b JOIN authors a ON a.id = b.author_id WHERE a.name = ?", ("x",))
    cursor.execute("INSERT INTO reviews (book_id, body) VALUES (?, ?)", (1, "ok"))
    cursor.execute("UPDATE books SET book_title = ? WHERE id = ?", ("t", 1))
    conn.execute(text("DELETE FROM book_tags WHERE tag = :t"))


async def raw_asyncpg(connection):
    rows = await connection.fetch("SELECT id, label FROM publisher WHERE label LIKE $1", "a%")
    await connection.execute(f"INSERT INTO orders (label) VALUES ({rows[0]['label']})")
    return await connection.fetchrow("""
        SELECT * FROM orders o
        JOIN publisher p ON p.id = o.publisher_id
    """)
