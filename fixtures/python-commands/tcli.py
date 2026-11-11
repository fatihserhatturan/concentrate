import typer

app = typer.Typer()
users = typer.Typer()
app.add_typer(users, name="users")


@app.command()
def hello_world():
    pass


@users.command("create")
def create_user():
    pass
