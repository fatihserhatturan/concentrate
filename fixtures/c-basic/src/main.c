#include <stdio.h>
#include "list.h"

static void report(const List* list) {
  printf("%d of %zu\n", list_sum(list), list_length(list));
}

int main(void) {
  List list = LIST_INIT;
  list_push(&list, 1);
  list_push(&list, 2);
  if (!LIST_EMPTY(&list)) report(&list);
  return 0;
}
