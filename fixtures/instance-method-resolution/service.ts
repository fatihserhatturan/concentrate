export class LocalService {
  run() {
    return 'local'
  }

  stop() {
    return 'stopped'
  }
}

export class ImportedService {
  execute() {
    return 'imported'
  }
}
