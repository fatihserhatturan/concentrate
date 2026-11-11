from flask import Blueprint

bp = Blueprint("auth", __name__)


@bp.route("/login", methods=["GET", "POST"])
def login():
    return "login"


@bp.get("/logout")
def logout():
    return "bye"
