function createClient() {
  return "client";
}

class ClientFactory {
  create() {
    return createClient();
  }
}

const defaultTimeout = 5000;
const internalOnly = true;

module.exports = {
  createClient,
  ClientFactory,
  defaultTimeout,
  name: "commonjs",
  make: () => createClient(),
};

module.exports.extra = defaultTimeout;
