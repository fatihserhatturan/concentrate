import { Controller, DELETE, GET as Get_, PUT } from 'fastify-decorators';

@Controller('/users')
export default class UsersController {
  @Get_('/:id')
  async show() {
    return {};
  }

  @DELETE('/:id')
  async remove() {
    return {};
  }

  @PUT()
  async replace() {
    return {};
  }
}
