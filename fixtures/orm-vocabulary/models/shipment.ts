import { Column, Model, Table } from 'sequelize-typescript';

@Table
export class Shipment extends Model {
  @Column
  declare carrier: string;
}

// A subclass of a model is a model too.
export class ExpressShipment extends Shipment {}
