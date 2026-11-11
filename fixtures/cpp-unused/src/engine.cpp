#include "engine.h"
void Engine::start() { used_api(1); }
int used_api(int v) { return v; }
int unused_api(int v) { return v + 1; }
static int dead_static(int v) { return v; }
