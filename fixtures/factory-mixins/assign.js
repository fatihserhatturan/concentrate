var proto = require('./lib/application');

function makeApp() {
  const made = {};
  Object.assign(made, proto);
  return made;
}

var assigned = makeApp();
assigned.init();
