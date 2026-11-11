import click


@click.group()
def cli():
    pass


@cli.command()
def run_server_command():
    pass


@cli.group()
def db():
    pass


@db.command("migrate")
def migrate_db():
    pass


@click.command()
def standalone():
    pass


cli.add_command(standalone, name="solo")
