import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findOne(id: number) {
    return this.usersRepository.findOneBy({ id });
  }

  async page(active: boolean) {
    const [users, total] = await this.usersRepository.findAndCountBy({ active });
    const admins = await this.usersRepository.findBy({ role: 'admin' });
    return { users, total, admins };
  }

  async stats() {
    const count = await this.usersRepository.countBy({ active: true });
    const exists = await this.usersRepository.existsBy({ role: 'owner' });
    const credits = await this.usersRepository.sum('credits');
    return { count, exists, credits };
  }

  async touch(id: number) {
    await this.usersRepository.increment({ id }, 'logins', 1);
    await this.usersRepository.restore(id);
  }

  async remove(id: number) {
    await this.usersRepository.softDelete(id);
  }

  async reset() {
    await this.usersRepository.clear();
  }
}
