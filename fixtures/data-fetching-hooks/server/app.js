const express = require('express');

const app = express();

app.get('/api/user', (req, res) => res.json({}));
app.get('/api/todos', (req, res) => res.json([]));
app.get('/api/todos/:id', (req, res) => res.json({}));
app.post('/api/todos', (req, res) => res.status(201).end());

module.exports = app;
