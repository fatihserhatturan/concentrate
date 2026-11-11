#include "parser.h"
#include "util.h"

int parse_number(const char *text) { return util_double(text[0] - '0'); }
