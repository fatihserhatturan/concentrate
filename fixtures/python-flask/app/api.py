from flask import Blueprint
from flask.views import MethodView
from flask_restful import Api, Resource

bp = Blueprint("api", __name__, url_prefix="/api")
admin = Blueprint("admin", __name__, url_prefix="/admin")
rest = Api(bp)
bp.register_blueprint(admin)


@bp.before_request
def check_token():
    pass


@bp.route("/users/<int:user_id>", methods=["GET", "DELETE"])
def user(user_id):
    return {}


class ItemsView(MethodView):
    def get(self):
        return []

    def post(self):
        return {}


bp.add_url_rule("/items", view_func=ItemsView.as_view("items"))


@admin.route("/stats")
def stats():
    return {}


class Health(Resource):
    def get(self):
        return {"ok": True}


rest.add_resource(Health, "/health")
