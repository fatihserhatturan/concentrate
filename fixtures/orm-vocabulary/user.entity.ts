import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  role: string;

  @Column()
  active: boolean;

  @Column()
  credits: number;

  @Column()
  logins: number;
}
