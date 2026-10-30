import { DataTypes, Model, Sequelize } from 'sequelize';

const sequelize = new Sequelize('sqlite::memory:');

export class Customer extends Model {
  declare id: number;
  declare name: string;
}

Customer.init({ name: DataTypes.STRING }, { sequelize, tableName: 'customers' });
