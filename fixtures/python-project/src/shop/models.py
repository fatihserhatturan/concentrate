class Customer:
    def __init__(self, name):
        self.name = name


class Order:
    def __init__(self, customer, total):
        self.customer = customer
        self.total = total
