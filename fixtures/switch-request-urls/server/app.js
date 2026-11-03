const express = require('express');

const app = express();

app.get('/api/articles', (req, res) => res.json([]));
app.get('/api/articles/feed', (req, res) => res.json([]));
app.get('/api/tags', (req, res) => res.json([]));
app.get('/api/profiles/:username', (req, res) => res.json({}));

module.exports = app;
