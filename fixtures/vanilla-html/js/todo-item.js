class TodoItem extends HTMLElement {
  connectedCallback() {
    this.addEventListener('click', () => this.toggle());
  }

  toggle() {
    this.classList.toggle('done');
  }
}

function onReady() {
  document.querySelector('#add').addEventListener('click', onAdd);
}

function onAdd() {
  return document.createElement('todo-item');
}

customElements.define('todo-item', TodoItem);
window.addEventListener('DOMContentLoaded', onReady);
document.addEventListener('keydown', (event) => onAdd(event.key));
