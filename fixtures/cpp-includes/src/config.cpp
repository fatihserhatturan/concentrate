#include "app/config.h"
#include <fmt/format.h>
#include <vector>
#include "missing/nothing.h"

namespace app {
int version() { return fmt::pad(3); }
}
