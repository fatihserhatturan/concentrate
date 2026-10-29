function fallback() {
  return null;
}

function createStore() {
  return new Map();
}

const cache = new Map();
cache.get('/x', fallback);

const store = createStore();
store.get('/y', fallback);

module.exports = { cache, store };
