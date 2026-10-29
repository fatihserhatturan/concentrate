const express = require('express');
const KoaRouter = require('@koa/router');

function home(req, res) {
  res.send('home');
}

function login(req, res) {
  res.send('ok');
}

function handle(ctx) {
  ctx.body = 'ok';
}

const main = express();
main.get('/', home);

var server = module.exports = express();
server.post('/login', login);

const web = new KoaRouter();
web.get('/k', handle);

const srv = require('fastify')();
srv.get('/f', handle);
