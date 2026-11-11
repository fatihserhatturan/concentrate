from .services.orders import run


def main():
    return run()


class Admin:
    @staticmethod
    def run():
        return main()


if __name__ == "__main__":
    main()
