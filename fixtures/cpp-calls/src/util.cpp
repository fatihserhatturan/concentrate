#include "geo/util.h"

namespace geo::util {

static int bounded(int count) { return CLAMP(count, 0, MAX_SHAPES); }

int clamp_count(int count) { return bounded(count); }

void log_line(const char* text) { log_line(text, 0); }

void log_line(const char* text, int level) { (void)text; (void)level; }

}  // namespace geo::util
