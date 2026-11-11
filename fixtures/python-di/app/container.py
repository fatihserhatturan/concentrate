from dependency_injector import containers, providers

from .services import Database, Mailer, OrderService, Repository, make_mailer


class Container(containers.DeclarativeContainer):
    config = providers.Configuration()

    db = providers.Singleton(Database, url=config.db_url)
    repository = providers.Factory(Repository, db=db)
    mailer = providers.Callable(make_mailer, db)
    orders = providers.Factory(OrderService, repository, mail=mailer, extra=providers.Factory(Repository, db=db))
