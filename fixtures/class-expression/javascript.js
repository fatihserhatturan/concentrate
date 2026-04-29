function helper(value) {
  return value;
}

export const InlineService = class extends BaseService {
  cache = new Map();

  find(id) {
    return helper(id);
  }
};

const LocalWorker = class NamedWorker {
  run() {
    return helper("local");
  }
};
