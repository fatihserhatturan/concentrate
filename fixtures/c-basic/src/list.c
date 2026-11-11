#include <stdlib.h>
#include "list.h"

static Node* make_node(int value) {
  Node* node = malloc(sizeof(Node));
  node->value = value;
  node->next = NULL;
  return node;
}

void list_push(List* list, int value) {
  Node* node = make_node(value);
  node->next = list->head;
  list->head = node;
  list->length += 1;
}

int list_sum(const List* list) {
  int total = 0;
  for (const Node* n = list->head; n; n = n->next) total += n->value;
  return total;
}

size_t list_length(const List* list) { return list->length; }

static void unused_helper(void) {}
