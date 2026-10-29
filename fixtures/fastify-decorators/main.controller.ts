import { Controller, GET, Hook, POST } from 'fastify-decorators';

const ITEMS = '/items';

@Controller({
  route: '/main',
})
export class MainController {
  @GET({ url: '/' })
  async index() {
    return { ok: true };
  }

  @POST({ url: ITEMS })
  async create() {
    return { created: true };
  }

  @Hook('onSend')
  async poweredBy() {
    return null;
  }
}
