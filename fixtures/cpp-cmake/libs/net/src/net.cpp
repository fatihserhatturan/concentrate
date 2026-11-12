#include <net/net.h>
#include <core/core.h>

namespace net {
int send(int value) { return value + core::answer(); }
}
