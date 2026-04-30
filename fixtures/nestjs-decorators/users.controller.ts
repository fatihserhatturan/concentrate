import { Controller, Get, Post, Delete, Param, Body, UseGuards } from '@nestjs/common'
import { AuthGuard } from './auth.guard'
import { UsersService } from './users.service'

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll()
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id)
  }

  @Post()
  create(@Body() body: unknown) {
    return this.usersService.create(body)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.remove(id)
  }
}
