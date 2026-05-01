import { Module } from '@nestjs/common'
import { UsersModule } from './users.module'
import { AuthService } from './auth.service'

class AppController {}
class AppService {}

@Module({
  imports: [UsersModule],
  controllers: [AppController],
  providers: [AppService, AuthService],
  exports: [AppService, AuthService],
})
export class AppModule {}
