const express = require('express');

const app = express();

app.get('/api/posts', (req, res) => res.json([]));
app.post('/api/posts', (req, res) => res.status(201).end());
app.get('/api/posts/:id', (req, res) => res.json({}));

module.exports = app;
