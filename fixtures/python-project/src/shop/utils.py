__all__ = ["slugify"]


def slugify(text):
    return text.lower().replace(" ", "-")


def _internal():
    return None
