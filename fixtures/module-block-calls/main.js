const { start, setup, fallback, stop, cleanup, inLoop } = require('./lib');

if (!module.parent) {
  start(3000);
} else if (process.env.SETUP) setup();
else {
  fallback();
}

try {
  setup();
} catch (error) {
  stop(error);
} finally {
  cleanup();
}

{
  start(1);
}

for (const value of [1, 2]) {
  inLoop(value);
}

function later() {
  if (process.env.STOP) {
    stop();
  }
}
