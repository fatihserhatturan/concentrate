from fastapi import FastAPI

from .repository import add_author, find_book, list_authors, remove_review

app = FastAPI()


@app.get("/authors")
def authors():
    return list_authors(None)


@app.post("/authors")
def create_author(name: str):
    return add_author(None, name)


@app.get("/books/{book_id}")
def book(book_id: int):
    return find_book(None, book_id)


@app.delete("/reviews/{review_id}")
def delete_review(review_id: int):
    return remove_review(None, None)
