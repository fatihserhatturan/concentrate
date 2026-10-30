import { DataTypes, Sequelize } from 'sequelize';

const sequelize = new Sequelize('sqlite::memory:');

const Order = sequelize.define('Order', { total: DataTypes.INTEGER });
const Invoice = sequelize.define('Invoice', { amount: DataTypes.INTEGER });

export async function listOrders(page: number) {
  return Order.findAndCountAll({ limit: 20, offset: page * 20 });
}

export async function importOrders(rows: Array<{ total: number }>) {
  await Order.bulkCreate(rows);
  return Invoice.bulkCreate(rows.map((row) => ({ amount: row.total })));
}

// Not an ORM receiver: this must not become data access.
export function groupRows(rows: Array<{ total: number }>, grouper: { groupBy(rows: unknown[]): unknown }) {
  return grouper.groupBy(rows);
}
