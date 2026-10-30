import { Customer } from './models/customer';
import { ExpressShipment, Shipment } from './models/shipment';

export async function listCustomers() {
  return Customer.findAll({ order: [['name', 'ASC']] });
}

export async function renameCustomer(id: number, name: string) {
  return Customer.update({ name }, { where: { id } });
}

export async function shipOrder(carrier: string) {
  await Shipment.create({ carrier });
  return ExpressShipment.count();
}

// Not a Sequelize model: a plain class whose static method shares a name.
class Ledger {
  static findAll() {
    return [];
  }
}

export function ledgerEntries() {
  return Ledger.findAll();
}
