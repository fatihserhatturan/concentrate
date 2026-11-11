#include <net/net.h>
#include <core/core.h>
#include APP_CONFIG_HEADER

int main() {
  return net::send(core::answer() + APP_LEVEL);
}
