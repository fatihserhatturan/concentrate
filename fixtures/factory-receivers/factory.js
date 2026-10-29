const express = require('express');

function inner(req, res) {
  res.send('inner');
}

function build() {
  const api = express.Router();
  api.get('/inner', inner);
  return api;
}

module.exports = build;
