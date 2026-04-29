function createClient(): string {
  return "client";
}

class LocalClient {
  connect(): string {
    return createClient();
  }
}

const defaultTimeout = 5000;

const ignoredSetting = true;

export { createClient, LocalClient as PublicClient, defaultTimeout };
