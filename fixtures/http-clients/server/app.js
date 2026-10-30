const express = require('express');

const app = express();

app.get('/api/users', (req, res) => res.json([]));
app.post('/api/users', (req, res) => res.status(201).end());
app.get('/api/users/me', (req, res) => res.json({}));
app.get('/api/users/:id', (req, res) => res.json({}));
app.patch('/api/users/:id', (req, res) => res.end());
app.delete('/api/users/:id', (req, res) => res.end());
app.get('/files/*', (req, res) => res.end());
// Two routes that match the same URLs: a call to /api/items/x stays unlinked.
app.get('/api/items/:id', (req, res) => res.end());
app.get('/api/items/:slug', (req, res) => res.end());

module.exports = app;
