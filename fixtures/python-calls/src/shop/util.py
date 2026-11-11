def slugify(text):
    return text.lower()


def make_repo() -> "MemoryRepo":
    from shop.repo import MemoryRepo
    return MemoryRepo()
