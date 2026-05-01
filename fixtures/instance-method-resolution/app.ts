import { ImportedService } from './service'

class AppService {
  run() {
    return 'app'
  }
}

const appService = new AppService()
const importedService = new ImportedService()

export function start() {
  appService.run()
  importedService.execute()
}
