from flask import Flask

from . import api
from .auth import bp as auth_bp


def create_app():
    app = Flask(__name__)
    app.register_blueprint(auth_bp, url_prefix="/auth")
    app.register_blueprint(api.bp)
    app.register_blueprint(api.bp, url_prefix="/v2", name="api_v2")

    @app.before_request
    def load_user():
        pass

    @app.route("/")
    def index():
        return "ok"

    return app
