#ifndef LIST_H
#define LIST_H

#include <stddef.h>

#define LIST_INIT { NULL, 0 }
#define LIST_EMPTY(l) ((l)->length == 0)
#define LIST_API

typedef struct Node {
  int value;
  struct Node* next;
} Node;

typedef struct {
  Node* head;
  size_t length;
} List;

enum ListError { LIST_OK, LIST_FULL };

#ifdef __cplusplus
extern "C"
{
#endif

LIST_API void list_push(List* list, int value);
int list_sum(const List* list);
size_t list_length(const List* list);

#ifdef __cplusplus
}
#endif

#endif
