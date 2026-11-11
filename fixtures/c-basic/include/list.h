#ifndef LIST_H
#define LIST_H

#include <stddef.h>

#define LIST_INIT { NULL, 0 }
#define LIST_EMPTY(l) ((l)->length == 0)

typedef struct Node {
  int value;
  struct Node* next;
} Node;

typedef struct {
  Node* head;
  size_t length;
} List;

enum ListError { LIST_OK, LIST_FULL };

void list_push(List* list, int value);
int list_sum(const List* list);
size_t list_length(const List* list);

#endif
