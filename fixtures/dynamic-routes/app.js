const express = require('express');

const app = express();

app.get('/health', (req, res) => res.end());

// Walks a nested object: method and path are computed.
app.map = function (routes, prefix) {
  for (const key in routes) {
    if (typeof routes[key] === 'object') app.map(routes[key], prefix + key);
    else app[key](prefix, routes[key]);
  }
};

// `this` is the app the helper is assigned to.
app.resource = function (path, controller) {
  this.get(path, controller.list);
  this.delete(path + '/:id', controller.remove);
};

// A router created in the function.
function mount(name, methods) {
  const router = express.Router();
  for (const method of methods) router[method]('/' + name, (req, res) => res.end());
  return router;
}

// Not registrations: a string member, an arrow's `this`, and other objects.
app['get']('/static', (req, res) => res.end());
app.later = () => this.get('/x', (req, res) => res.end());
const handlers = { a() {}, b() {} };
for (const key of Object.keys(handlers)) handlers[key]('/a');

module.exports = { app, mount };
