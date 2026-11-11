#pragma once

#define CLAMP(x, lo, hi) ((x) < (lo) ? (lo) : (x) > (hi) ? (hi) : (x))
#define MAX_SHAPES 16

namespace geo::util {

int clamp_count(int count);
void log_line(const char* text);
void log_line(const char* text, int level);
void log_format(const char* format, ...);

}  // namespace geo::util
