from flask import Flask

app = Flask(__name__)


@app.cli.command("seed")
def seed():
    pass
